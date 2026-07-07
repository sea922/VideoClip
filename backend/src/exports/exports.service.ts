import {
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { RedisService } from '../common/redis.service';
import { CreateExportDto } from './dto/create-export.dto';

@Injectable()
export class ExportsService {
  constructor(
    @Inject('EXPORT_QUEUE') private readonly exportQueue: Queue,
    private readonly redisService: RedisService,
  ) {}

  async createExport(
    dto: CreateExportDto,
  ): Promise<{ exportId: string; jobId: string }> {
    // Guard: reject if queue is too full
    const waitingCount = await this.exportQueue.getWaitingCount();
    const maxDepth = Number(process.env.QUEUE_MAX_DEPTH ?? 10);

    if (waitingCount >= maxDepth) {
      throw new HttpException(
        'Server is busy — please try again in a few minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const exportId = crypto.randomUUID();
    const job = await this.exportQueue.add('export', {
      exportId,
      videoId: dto.videoId,
      clips: dto.clips,
      transition: dto.transition,
    }, { jobId: exportId });

    // Store initial status in Redis
    await this.redisService.hset(`export:${exportId}`, {
      status: 'queued',
      createdAt: new Date().toISOString(),
    });

    return { exportId, jobId: job.id! };
  }

  async getExport(exportId: string): Promise<{
    exportId: string;
    status: string;
    presignedUrl?: string;
  }> {
    const data = await this.redisService.hgetall(`export:${exportId}`);
    if (!data) {
      throw new NotFoundException(
        `Export ${exportId} not found — it may have expired or still be processing`,
      );
    }

    return {
      exportId,
      status: data.status,
      presignedUrl: data.presignedUrl,
    };
  }
}
