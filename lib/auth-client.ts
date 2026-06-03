import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { roleAccess } from "./rbac";

export const authClient = createAuthClient({
    plugins: [
        adminClient({
            roles: roleAccess,
        }),
    ],
});
