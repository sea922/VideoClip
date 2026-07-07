import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { JobsModule } from './jobs/jobs.module';
import { VideosModule } from './videos/videos.module';
import { ExportsModule } from './exports/exports.module';

@Module({
  imports: [
    CommonModule,
    JobsModule,
    VideosModule,
    ExportsModule,
  ],
})
export class AppModule {}
