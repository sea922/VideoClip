import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { Queue, Worker } from 'bullmq';
import { DownloadProcessor } from './processors/download.processor';
import { ExportProcessor } from './processors/export.processor';
import { CommonModule } from '../common/common.module';

const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

const downloadQueue = new Queue('download', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

const exportQueue = new Queue('export', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 50,
  },
});

@Module({
  imports: [CommonModule],
  controllers: [JobsController],
  providers: [
    {
      provide: 'DOWNLOAD_QUEUE',
      useValue: downloadQueue,
    },
    {
      provide: 'EXPORT_QUEUE',
      useValue: exportQueue,
    },
    {
      provide: JobsService,
      useFactory: () => {
        const svc = new JobsService(downloadQueue, exportQueue);
        return svc;
      },
    },
    DownloadProcessor,
    ExportProcessor,
  ],
  exports: [JobsService, 'DOWNLOAD_QUEUE', 'EXPORT_QUEUE'],
})
export class JobsModule {}
