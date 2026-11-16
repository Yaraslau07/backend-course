/* eslint-disable @typescript-eslint/unbound-method -- handlers are read as metadata targets, never called */
import { Controller, Get } from '@nestjs/common';

import {
  getRouteAccess,
  Internal,
  Public,
  Receipt,
  RequirePermission,
  resolveRouteAccess,
  ROUTE_ACCESS_METADATA,
} from './route-access';

/** Declarations as the decorators store them, for testing the resolver directly. */
const pub = { kind: 'public' } as const;
const internal = { kind: 'internal' } as const;
const pair = (permission: string, action: string) =>
  ({ kind: 'permission', permission, action }) as const;
const receipt = (header: string) => ({ kind: 'receipt', header }) as const;

describe('resolveRouteAccess()', () => {
  it('a route with no declaration is invalid (missing)', () => {
    expect(resolveRouteAccess(undefined)).toEqual({
      kind: 'invalid',
      reason: 'missing',
    });
    expect(resolveRouteAccess([])).toEqual({
      kind: 'invalid',
      reason: 'missing',
    });
  });

  it('public alone is public', () => {
    expect(resolveRouteAccess([pub])).toEqual({ kind: 'public' });
  });

  it('internal alone is internal', () => {
    expect(resolveRouteAccess([internal])).toEqual({ kind: 'internal' });
  });

  it('exactly one pair is protected, with normalized names', () => {
    expect(resolveRouteAccess([pair(' Users ', 'READ_ANY')])).toEqual({
      kind: 'protected',
      permission: 'users',
      action: 'read_any',
    });
  });

  it('a receipt alone, or with one pair, is a receipt route', () => {
    expect(resolveRouteAccess([receipt('Deletion-Receipt')])).toEqual({
      kind: 'receipt',
      header: 'deletion-receipt',
    });
    expect(
      resolveRouteAccess([
        receipt('Deletion-Receipt'),
        pair('users', 'delete'),
      ]),
    ).toEqual({
      kind: 'receipt',
      header: 'deletion-receipt',
      pair: { permission: 'users', action: 'delete' },
    });
  });

  it.each([
    ['public twice', [pub, pub]],
    ['public with a pair', [pub, pair('users', 'read')]],
    ['public with a receipt', [pub, receipt('X-Receipt')]],
    ['internal with public', [internal, pub]],
    ['internal with a pair', [internal, pair('users', 'read')]],
    ['two pairs', [pair('users', 'read'), pair('users', 'update')]],
    ['the same pair twice', [pair('users', 'read'), pair('users', 'read')]],
    ['two receipts', [receipt('A-Receipt'), receipt('B-Receipt')]],
    [
      'a receipt with two pairs',
      [receipt('X-Receipt'), pair('a', 'b'), pair('c', 'd')],
    ],
  ])('%s is invalid (conflict)', (_name, declarations) => {
    expect(resolveRouteAccess(declarations)).toEqual({
      kind: 'invalid',
      reason: 'conflict',
    });
  });

  it.each([
    ['an empty permission', pair('', 'read')],
    ['a permission with a space inside', pair('user s', 'read')],
    ['a permission starting with a digit', pair('1users', 'read')],
    ['a permission over 64 characters', pair('a'.repeat(65), 'read')],
    ['an action with a symbol', pair('users', 'read!')],
  ])('%s is invalid (invalid_name)', (_name, declaration) => {
    expect(resolveRouteAccess([declaration])).toEqual({
      kind: 'invalid',
      reason: 'invalid_name',
    });
  });

  it.each(['', 'Bad Header', 'x'.repeat(65), 'snake_case'])(
    'a receipt header %p is invalid (invalid_name)',
    (header) => {
      expect(resolveRouteAccess([receipt(header)])).toEqual({
        kind: 'invalid',
        reason: 'invalid_name',
      });
    },
  );

  it('anything that is not a known declaration is invalid', () => {
    expect(resolveRouteAccess([{ kind: 'admin' }])).toEqual({
      kind: 'invalid',
      reason: 'conflict',
    });
    expect(resolveRouteAccess('public' as unknown as unknown[])).toEqual({
      kind: 'invalid',
      reason: 'conflict',
    });
  });
});

describe('decorators', () => {
  @Controller('things')
  class ThingsController {
    @Get('a')
    @Public()
    a() {}

    @Get('b')
    @RequirePermission('things', 'read')
    b() {}

    @Get('c')
    @Receipt('Thing-Receipt')
    @RequirePermission('things', 'read')
    c() {}

    @Get('d')
    @Public()
    @RequirePermission('things', 'read')
    d() {}

    @Get('e')
    e() {}

    @Get('f')
    @Internal()
    f() {}
  }
  const proto = ThingsController.prototype;

  it('store every declaration on the handler, so conflicts stay visible', () => {
    expect(Reflect.getMetadata(ROUTE_ACCESS_METADATA, proto.d)).toHaveLength(2);
  });

  it('resolve through getRouteAccess()', () => {
    expect(getRouteAccess(proto.a)).toEqual({ kind: 'public' });
    expect(getRouteAccess(proto.b)).toEqual({
      kind: 'protected',
      permission: 'things',
      action: 'read',
    });
    expect(getRouteAccess(proto.c)).toEqual({
      kind: 'receipt',
      header: 'thing-receipt',
      pair: { permission: 'things', action: 'read' },
    });
    expect(getRouteAccess(proto.d)).toEqual({
      kind: 'invalid',
      reason: 'conflict',
    });
    expect(getRouteAccess(proto.e)).toEqual({
      kind: 'invalid',
      reason: 'missing',
    });
    expect(getRouteAccess(proto.f)).toEqual({ kind: 'internal' });
  });

  it('mark protected routes with the cookie security scheme for OpenAPI, and public ones not', () => {
    expect(Reflect.getMetadata('swagger/apiSecurity', proto.b)).toEqual([
      { access_token: [] },
    ]);
    expect(Reflect.getMetadata('swagger/apiSecurity', proto.a)).toBeUndefined();
  });
});
