import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

/**
 * APW-08 T25 — `POST /api/works/:id/evolve` (plan §4: `EvolveWorkDto { request (1–4000),
 * agentId? }`). `attachmentUploadIds` is deferred with T54's keyed thread posts.
 */
export class EvolveWorkDto {
    @ApiProperty({
        description:
            'What to change, in the member’s words (1–4000 characters). It becomes the Task’s brief verbatim.',
        minLength: 1,
        maxLength: 4000,
    })
    @IsString()
    @Length(1, 4000)
    request!: string;

    @ApiPropertyOptional({
        description:
            'The Agent to run the change. Omit to let APW-08’s rule decide (recent Task → only pinned → only assigned → only tenant Agent; archived or non-committing Agents skipped).',
        format: 'uuid',
    })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiPropertyOptional({
        description: 'Where the request came from, for the Task brief.',
        enum: ['chat', 'card', 'api'],
    })
    @IsOptional()
    @IsIn(['chat', 'card', 'api'])
    channel?: 'chat' | 'card' | 'api';
}

/** APW-04 — `POST /api/works/:id/provision` (plan §4.1: `{ restart?, note? (≤ 500) }`). */
export class ProvisionWorkDto {
    @ApiPropertyOptional({
        description:
            'Start even when an `app-provision` Task is already open (it is left as is; a new one is filed).',
    })
    @IsOptional()
    @IsBoolean()
    restart?: boolean;

    @ApiPropertyOptional({ description: 'A note for the provisioning Agent (≤ 500 characters).', maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    note?: string;

    @ApiPropertyOptional({ description: 'Pin the provisioning Agent.', format: 'uuid' })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    @ApiPropertyOptional({
        description: 'Inspect only: answer the detection and the validated draft, create nothing.',
    })
    @IsOptional()
    @IsBoolean()
    dryRun?: boolean;
}
