import type { UserStatus } from './users.types';

export interface ProfileRow {
  id: string;
  email: string;
  display_name: string | null;
  photo_key: string | null;
  status: UserStatus;
  created_at: Date;
  updated_at: Date;
}

export interface SafeProfile {
  id: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export function safeProfile(row: ProfileRow, baseUrl: string): SafeProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    photoUrl:
      row.photo_key && row.status !== 'deleting' && row.status !== 'deleted'
        ? `${baseUrl.replace(/\/+$/, '')}/users/${encodeURIComponent(row.id)}/photo`
        : null,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
