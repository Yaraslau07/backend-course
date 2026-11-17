import { RbacDescription, RbacName } from './rbac-fields';

/** Spec 1.1 §1.3.2: create and replace take the same body. */
export class RoleDto {
  @RbacName()
  name!: string;

  @RbacDescription()
  description!: string | null;
}
