import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { RedisService } from '../../common/redis.service';

@Injectable()
export class DownloadProcessor implements OnModuleInit {
  private readonly logger = new Logger(DownloadProcessor.name);
  private worker: Worker;

  constructor(private readonly redisService: RedisService) {}

  onModuleInit() {
    const connection = {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
    };

    this.worker = new Worker(
      'download',
      async (job: Job) => {
        return this.process(job);
      },
      {
        connection,
        concurrency: Number(process.env.MAX_CONCURRENT_JOBS ?? 1),
      },
    );

    this.worker.on('completed', (job) =>
      this.logger.log(`Download job ${job.id} completed`),
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Download job ${job?.id} failed: ${err.message}`),
    );
  }

  private async process(job: Job): Promise<void> {
    const { videoId, url } = job.data as { videoId: string; url: string };
    const workerUrl = process.env.WORKER_URL ?? 'http://worker:8000';

    this.logger.log(`Downloading video ${videoId} from ${url}`);
    await job.updateProgress(0);

    let finalResult: any = null;
    let lastProgressUpdate = 0;

    try {
      const response = await axios.post(
        `${workerUrl}/download`,
        { url, video_id: videoId },
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
                // Throttle updates to avoid spamming Redis
                if (now - lastProgressUpdate > 250 || data.progress >= 100) {
                  job.updateProgress(Math.round(data.progress)).catch(() => {});
                  lastProgressUpdate = now;
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

      const { s3_key, duration, title, thumbnail_url } = finalResult;

      // Store metadata in Redis
      await this.redisService.hset(`video:${videoId}`, {
        s3Key: s3_key,
        duration: String(duration),
        title: title ?? 'Untitled',
        thumbnailUrl: thumbnail_url ?? '',
      });

      await job.updateProgress(100);
      this.logger.log(`Video ${videoId} metadata stored in Redis`);
    } catch (error: any) {
      if (error.response && !error.response.data?.on) {
        // Not a stream error, just a regular axios error
        this.logger.error(`Worker responded with status ${error.response.status}`);
        throw new Error(error.response.data?.detail || error.message);
      } else {
        throw error;
      }
    }
  }
}
