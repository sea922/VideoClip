import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Redirect,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { VideosService } from './videos.service';
import { CreateVideoDto } from './dto/create-video.dto';

@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  /** POST /videos — Submit a YouTube URL for download */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  submitVideo(@Body() dto: CreateVideoDto) {
    return this.videosService.submitVideo(dto);
  }

  /** GET /videos/:id — Get video metadata (available once download completes) */
  @Get(':id')
  getVideo(@Param('id') id: string) {
    return this.videosService.getVideo(id);
  }

  /**
   * GET /videos/:id/stream
   * Generates a pre-signed URL and redirects (302) the browser to MinIO/S3.
   * Video bytes never flow through NestJS.
   */
  @Get(':id/stream')
  @Redirect()
  async streamVideo(@Param('id') id: string) {
    const url = await this.videosService.getStreamUrl(id);
    return { url, statusCode: 302 };
  }
}
