import {
  IsArray,
  IsEnum,
  IsUUID,
  ValidateNested,
  ArrayMinSize,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum Transition {
  CUT = 'cut',
  FADE = 'fade',
  SLIDE = 'slide',
}

export class ClipDto {
  @IsNumber()
  @Min(0)
  start: number;

  @IsNumber()
  @Min(0)
  end: number;
}

export class CreateExportDto {
  @IsUUID()
  videoId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ClipDto)
  clips: ClipDto[];

  @IsEnum(Transition)
  transition: Transition;
}
