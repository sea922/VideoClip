import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { RedisService } from '../../common/redis.service';
import { StorageService } from '../../common/storage.service';

@Injectable()
export class ExportProcessor implements OnModuleInit {
  private readonly logger = new Logger(ExportProcessor.name);
  private worker: Worker;

  constructor(
    private readonly redisService: RedisService,
    private readonly storageService: StorageService,
  ) {}

  onModuleInit() {
    const connection = {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    };

    this.worker = new Worker(
      'export',
      async (job: Job) => {
        return this.process(job);
      },
      {
        connection,
        concurrency: Number(process.env.MAX_CONCURRENT_JOBS ?? 1),
      },
    );

    this.worker.on('completed', (job) =>
      this.logger.log(`Export job ${job.id} completed`),
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Export job ${job?.id} failed: ${err.message}`),
    );
  }

  private async process(job: Job): Promise<void> {
    const { exportId, videoId, clips, transition } = job.data as {
      exportId: string;
      videoId: string;
      clips: Array<{ start: number; end: number }>;
      transition: string;
    };

    const workerUrl = process.env.WORKER_URL ?? 'http://worker:8000';
    this.logger.log(`Processing export ${exportId} for video ${videoId}`);

    await job.updateProgress(0);

    let finalResult: any = null;
    let lastProgressUpdate = 0;
    let isUpdating = false;

    try {
      const response = await axios.post(
        `${workerUrl}/process`,
        {
          video_id: videoId,
          export_id: exportId,
          clips,
          transition,
        },
        { responseType: 'stream' },
      );

      const stream = response.data;

      await new Promise<void>((resolve, reject) => {
        let buffer = '';
        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.progress !== undefined) {
                const now = Date.now();
                if (!isUpdating && (now - lastProgressUpdate > 250 || data.progress >= 100)) {
                  isUpdating = true;
                  lastProgressUpdate = now;
                  job.updateProgress(Math.round(data.progress)).finally(() => {
                    isUpdating = false;
                  });
                }
              } else if (data.result !== undefined) {
                finalResult = data.result;
              } else if (data.error !== undefined) {
                reject(new Error(data.error));
              }
            } catch (e) {
              this.logger.error(`Failed to parse worker chunk: ${line}`);
            }
          }
        });

        stream.on('end', () => resolve());
        stream.on('error', (err: any) => reject(err));
      });

      if (!finalResult) {
        throw new Error('Worker stream ended without providing a result');
      }

      const { s3_key } = finalResult;

      // Generate pre-signed URL (15-min expiry) — browser downloads directly from MinIO/S3
      const presignedUrl = await this.storageService.generatePresignedUrl(
        s3_key,
        Number(process.env.PRESIGNED_URL_EXPIRY_SECONDS ?? 900),
      );

      // Store result in Redis (no DB needed — this is all the persistence required)
      await this.redisService.hset(`export:${exportId}`, {
        s3Key: s3_key,
        presignedUrl,
        status: 'done',
        createdAt: new Date().toISOString(),
      });

      await job.updateProgress(100);
      this.logger.log(`Export ${exportId} ready — pre-signed URL generated`);
    } catch (error: any) {
      if (error.response && !error.response.data?.on) {
        this.logger.error(`Worker responded with status ${error.response.status}`);
        throw new Error(error.response.data?.detail || error.message);
      } else {
        throw error;
      }
    }
  }
}
