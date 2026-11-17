/* eslint-disable @typescript-eslint/no-unused-vars -- signature-only stub, implemented in the feat commit */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { GrantDto } from './dto/grant.dto';
import type { PermissionDto } from './dto/permission.dto';
import type { RoleDto } from './dto/role.dto';

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionView extends RoleView {
  actions: string[];
}

export interface GrantView {
  id: string;
  roleId: string;
  permissionId: string;
  allActions: boolean;
  actions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserRolesView {
  userId: string;
  roleIds: string[];
}

/**
 * Spec 1.1 §1.3.2–1.3.5. Every change runs in one transaction that locks `rbac_policy_state` first,
 * checks that an active `rbac@manage` holder remains, and bumps the version.
 */
@Injectable()
export class RbacAdminService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  listRoles(): Promise<RoleView[]> {
    throw new Error('not implemented');
  }
  createRole(_actor: string, _dto: RoleDto): Promise<RoleView> {
    throw new Error('not implemented');
  }
  replaceRole(_actor: string, _id: string, _dto: RoleDto): Promise<RoleView> {
    throw new Error('not implemented');
  }
  deleteRole(_actor: string, _id: string): Promise<void> {
    throw new Error('not implemented');
  }

  listPermissions(): Promise<PermissionView[]> {
    throw new Error('not implemented');
  }
  createPermission(
    _actor: string,
    _dto: PermissionDto,
  ): Promise<PermissionView> {
    throw new Error('not implemented');
  }
  replacePermission(
    _actor: string,
    _id: string,
    _dto: PermissionDto,
  ): Promise<PermissionView> {
    throw new Error('not implemented');
  }
  deletePermission(_actor: string, _id: string): Promise<void> {
    throw new Error('not implemented');
  }

  listGrants(): Promise<GrantView[]> {
    throw new Error('not implemented');
  }
  createGrant(_actor: string, _dto: GrantDto): Promise<GrantView> {
    throw new Error('not implemented');
  }
  replaceGrant(
    _actor: string,
    _id: string,
    _dto: GrantDto,
  ): Promise<GrantView> {
    throw new Error('not implemented');
  }
  deleteGrant(_actor: string, _id: string): Promise<void> {
    throw new Error('not implemented');
  }

  getUserRoles(_userId: string): Promise<UserRolesView> {
    throw new Error('not implemented');
  }
  replaceUserRoles(
    _actor: string,
    _userId: string,
    _roleIds: string[],
  ): Promise<UserRolesView> {
    throw new Error('not implemented');
  }
}
