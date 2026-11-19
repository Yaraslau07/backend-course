import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UserRolesDto } from './user-roles.dto';

const ID = 'abcdef12-3456-4789-8abc-def012345678';
const errors = (roleIds: unknown) =>
  validate(plainToInstance(UserRolesDto, { roleIds }));

describe('UserRolesDto (spec 1.1 §1.3.5)', () => {
  it('a repeat that differs only by letter case is a repeat (400), not a missing role', async () => {
    expect(await errors([ID, ID.toUpperCase()])).not.toHaveLength(0);
  });

  it('unique ids pass, in any case, and are lowercased', async () => {
    expect(await errors([ID.toUpperCase()])).toHaveLength(0);
    const dto = plainToInstance(UserRolesDto, { roleIds: [ID.toUpperCase()] });
    expect(dto.roleIds).toEqual([ID]);
    expect(await errors([])).toHaveLength(0);
  });

  it('non-arrays and non-uuids stay invalid', async () => {
    expect(await errors('x')).not.toHaveLength(0);
    expect(await errors(['nope'])).not.toHaveLength(0);
  });
});
