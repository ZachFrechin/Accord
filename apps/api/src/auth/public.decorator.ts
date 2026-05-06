import { SetMetadata } from '@nestjs/common';

export const isPublicRouteKey = 'isPublicRoute';

export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(isPublicRouteKey, true);
