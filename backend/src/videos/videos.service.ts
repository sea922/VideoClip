import {
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { Inject } from '@nestjs/common';
import { RedisService } from '../common/redis.service';
import { StorageService } from '../common/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';

@Injectable()
export class VideosService {
  constructor(
    @Inject('DOWNLOAD_QUEUE') private readonly downloadQueue: Queue,
    private readonly redisService: RedisService,
    private readonly storageService: StorageService,
  ) {}

  async submitVideo(dto: CreateVideoDto): Promise<{ videoId: string; jobId: string }> {
    // Guard: check queue depth before accepting new work
    const waitingCount = await this.downloadQueue.getWaitingCount();
    const maxDepth = Number(process.env.QUEUE_MAX_DEPTH ?? 10);

    if (waitingCount >= maxDepth) {
      throw new HttpException(
        'Server is busy — please try again in a few minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const videoId = crypto.randomUUID();
    const job = await this.downloadQueue.add('download', {
      videoId,
      url: dto.url,
    }, { jobId: videoId });

    return { videoId, jobId: job.id! };
  }

  async getVideo(videoId: string): Promise<{
    videoId: string;
    s3Key: string;
    duration: number;
    title: string;
    thumbnailUrl: string;
  }> {
    const data = await this.redisService.hgetall(`video:${videoId}`);
    if (!data) {
      throw new NotFoundException(
        `Video ${videoId} not found — download may still be in progress`,
      );
    }

    return {
      videoId,
      s3Key: data.s3Key,
      duration: Number(data.duration),
      title: data.title,
      thumbnailUrl: data.thumbnailUrl,
    };
  }

  async getStreamUrl(videoId: string): Promise<string> {
    const data = await this.redisService.hgetall(`video:${videoId}`);
    if (!data?.s3Key) {
      throw new NotFoundException(`Video ${videoId} not found`);
    }
    // Short-lived URL for video preview streaming
    return this.storageService.generatePresignedUrl(data.s3Key, 3600);
  }
}
