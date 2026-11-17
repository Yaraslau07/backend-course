import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentUserId } from '@/core/authorization/current-user';
import { RequirePermission } from '@/core/authorization/route-access';

import { GrantDto } from './dto/grant.dto';
import { PermissionDto } from './dto/permission.dto';
import { RoleDto } from './dto/role.dto';
import { UserRolesDto } from './dto/user-roles.dto';
import {
  type GrantView,
  type PermissionView,
  RbacAdminService,
  type RoleView,
  type UserRolesView,
} from './rbac-admin.service';

const Id = (name: string) => Param(name, new ParseUUIDPipe());

/**
 * Spec 1.1 §1.3.2–1.3.5. Every route needs `rbac@manage`; the guard checks it before the body or
 * the target is looked at, so without it the answer is 403, never 404.
 */
@ApiTags('rbac')
@ApiResponse({ status: 401, description: '`invalid_session`' })
@ApiResponse({ status: 403, description: '`permission_denied`' })
@Controller('admin/rbac')
export class RbacAdminController {
  constructor(private readonly admin: RbacAdminService) {}

  @Get('roles')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'List roles' })
  listRoles(): Promise<RoleView[]> {
    return this.admin.listRoles();
  }

  @Post('roles')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'Create a role' })
  @ApiResponse({ status: 409, description: '`name_taken`' })
  createRole(
    @CurrentUserId() actor: string,
    @Body() dto: RoleDto,
  ): Promise<RoleView> {
    return this.admin.createRole(actor, dto);
  }

  @Put('roles/:roleId')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'Replace a role’s name and description' })
  replaceRole(
    @CurrentUserId() actor: string,
    @Id('roleId') id: string,
    @Body() dto: RoleDto,
  ): Promise<RoleView> {
    return this.admin.replaceRole(actor, id, dto);
  }

  @Delete('roles/:roleId')
  @RequirePermission('rbac', 'manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a role with no grants and no users' })
  @ApiResponse({ status: 409, description: '`resource_in_use`' })
  deleteRole(
    @CurrentUserId() actor: string,
    @Id('roleId') id: string,
  ): Promise<void> {
    return this.admin.deleteRole(actor, id);
  }

  @Get('permissions')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'List permissions with their actions' })
  listPermissions(): Promise<PermissionView[]> {
    return this.admin.listPermissions();
  }

  @Post('permissions')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'Create a permission with its actions' })
  createPermission(
    @CurrentUserId() actor: string,
    @Body() dto: PermissionDto,
  ): Promise<PermissionView> {
    return this.admin.createPermission(actor, dto);
  }

  @Put('permissions/:permissionId')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'Replace a permission and its whole action set' })
  replacePermission(
    @CurrentUserId() actor: string,
    @Id('permissionId') id: string,
    @Body() dto: PermissionDto,
  ): Promise<PermissionView> {
    return this.admin.replacePermission(actor, id, dto);
  }

  @Delete('permissions/:permissionId')
  @RequirePermission('rbac', 'manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a permission that no role is granted' })
  deletePermission(
    @CurrentUserId() actor: string,
    @Id('permissionId') id: string,
  ): Promise<void> {
    return this.admin.deletePermission(actor, id);
  }

  @Get('grants')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'List grants' })
  listGrants(): Promise<GrantView[]> {
    return this.admin.listGrants();
  }

  @Post('grants')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'Grant a role some or all actions of a permission' })
  @ApiResponse({
    status: 409,
    description: '`grant_exists`, `last_rbac_manager`',
  })
  createGrant(
    @CurrentUserId() actor: string,
    @Body() dto: GrantDto,
  ): Promise<GrantView> {
    return this.admin.createGrant(actor, dto);
  }

  @Put('grants/:grantId')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'Replace a grant' })
  replaceGrant(
    @CurrentUserId() actor: string,
    @Id('grantId') id: string,
    @Body() dto: GrantDto,
  ): Promise<GrantView> {
    return this.admin.replaceGrant(actor, id, dto);
  }

  @Delete('grants/:grantId')
  @RequirePermission('rbac', 'manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a grant' })
  deleteGrant(
    @CurrentUserId() actor: string,
    @Id('grantId') id: string,
  ): Promise<void> {
    return this.admin.deleteGrant(actor, id);
  }

  @Get('users/:userId/roles')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({ summary: 'The role ids of a user' })
  getUserRoles(@Id('userId') userId: string): Promise<UserRolesView> {
    return this.admin.getUserRoles(userId);
  }

  @Put('users/:userId/roles')
  @RequirePermission('rbac', 'manage')
  @ApiOperation({
    summary: 'Replace the roles of a user (an empty list removes all)',
  })
  @ApiResponse({ status: 409, description: '`last_rbac_manager`' })
  replaceUserRoles(
    @CurrentUserId() actor: string,
    @Id('userId') userId: string,
    @Body() dto: UserRolesDto,
  ): Promise<UserRolesView> {
    return this.admin.replaceUserRoles(actor, userId, dto.roleIds);
  }
}
