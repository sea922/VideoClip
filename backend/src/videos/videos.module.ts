import { Module } from '@nestjs/common';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { CommonModule } from '../common/common.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [CommonModule, JobsModule],
  controllers: [VideosController],
  providers: [VideosService],
})
export class VideosModule {}
