import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { roleAccess } from "./rbac";

export const authClient = createAuthClient({
    baseURL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    plugins: [
        adminClient({
            roles: roleAccess,
        }),
    ],
});
