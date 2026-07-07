import {
  IsString,
  IsUrl,
  Matches,
} from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  @Matches(
    /^https?:\/\/(www\.)?(youtube\.com\/(watch|shorts\/)|youtu\.be\/)/,
    { message: 'url must be a valid YouTube URL' },
  )
  url: string;
}
