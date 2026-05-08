import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { AuthUser } from '@discord2/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  CreateServerRoleDto,
  ReorderRolesDto,
  UpdateMemberRolesDto,
  UpdateServerRoleDto,
} from './dto';
import { RolesService } from './roles.service';

@Controller('servers/:serverId')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get('roles')
  listRoles(@CurrentUser() user: AuthUser, @Param('serverId') serverId: string) {
    return this.rolesService.listRoles(user, serverId);
  }

  @Post('roles')
  createRole(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Body() body: CreateServerRoleDto,
  ) {
    return this.rolesService.createRole(user, serverId, body);
  }

  @Patch('roles/:roleId')
  updateRole(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Param('roleId') roleId: string,
    @Body() body: UpdateServerRoleDto,
  ) {
    return this.rolesService.updateRole(user, serverId, roleId, body);
  }

  @Delete('roles/:roleId')
  deleteRole(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Param('roleId') roleId: string,
  ) {
    return this.rolesService.deleteRole(user, serverId, roleId);
  }

  @Post('roles/reorder')
  reorderRoles(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Body() body: ReorderRolesDto,
  ) {
    return this.rolesService.reorderRoles(user, serverId, body.roleIds);
  }

  @Get('members')
  listMembers(@CurrentUser() user: AuthUser, @Param('serverId') serverId: string) {
    return this.rolesService.listMembers(user, serverId);
  }

  @Patch('members/:userId/roles')
  updateMemberRoles(
    @CurrentUser() user: AuthUser,
    @Param('serverId') serverId: string,
    @Param('userId') userId: string,
    @Body() body: UpdateMemberRolesDto,
  ) {
    return this.rolesService.updateMemberRoles(user, serverId, userId, body);
  }
}
