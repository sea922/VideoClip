import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ExportsService } from './exports.service';
import { CreateExportDto } from './dto/create-export.dto';

@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  /** POST /exports — Submit a clip+merge export job */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  createExport(@Body() dto: CreateExportDto) {
    return this.exportsService.createExport(dto);
  }

  /**
   * GET /exports/:id
   * Returns { exportId, status, presignedUrl } once the export is done.
   * Frontend polls this after getting jobId from POST /exports.
   */
  @Get(':id')
  getExport(@Param('id') id: string) {
    return this.exportsService.getExport(id);
  }
}
