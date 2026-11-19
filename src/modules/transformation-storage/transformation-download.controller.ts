import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUserId } from '@/core/authorization/current-user';
import { RequirePermission } from '@/core/authorization/route-access';

import {
  type StoredDownload,
  TransformationDownloadService,
} from './transformation-download.service';

const FILE = { schema: { type: 'string', format: 'binary' } } as const;

const attachment = ({ stream, contentType, fileName }: StoredDownload) =>
  new StreamableFile(stream, {
    type: contentType,
    disposition: `attachment; filename="${fileName}"`,
  });

/** Spec 2.4 §1.3.2–1.3.3: the saved result, as an attachment, from the private store. */
@ApiTags('transformations')
@ApiResponse({ status: 401, description: 'Invalid session' })
@ApiResponse({ status: 409, description: 'The save is still pending' })
@ApiResponse({
  status: 503,
  description: 'Database unavailable, or history names an object storage lacks',
})
@Controller()
export class TransformationDownloadController {
  constructor(private readonly downloads: TransformationDownloadService) {}

  @Get('api/transformations/history/:itemId/download')
  @RequirePermission('transformations', 'download')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Download your saved transformation result' })
  @ApiParam({ name: 'itemId' })
  @ApiOkResponse(FILE)
  @ApiResponse({ status: 403, description: 'No transformations@download' })
  @ApiResponse({
    status: 404,
    description: 'Missing, foreign, unsaved, failed or expired',
  })
  async own(
    @CurrentUserId() actor: string,
    @Param('itemId') itemId: string,
  ): Promise<StreamableFile> {
    return attachment(await this.downloads.own(actor, itemId));
  }

  @Get('admin/users/:userId/transformations/history/:itemId/download')
  @RequirePermission('transformations', 'download_any')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: "Download a user's saved result (admin)" })
  @ApiParam({ name: 'userId' })
  @ApiParam({ name: 'itemId' })
  @ApiOkResponse(FILE)
  @ApiResponse({ status: 403, description: 'No transformations@download_any' })
  @ApiResponse({
    status: 404,
    description: 'User or item missing, unsaved, failed or expired',
  })
  async ofUser(
    @CurrentUserId() actor: string,
    @Param('userId') userId: string,
    @Param('itemId') itemId: string,
  ): Promise<StreamableFile> {
    return attachment(await this.downloads.ofUser(actor, userId, itemId));
  }
}
