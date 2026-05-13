import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
    id: text("id").primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull(),
    image: text('image'),
    role: text('role').default('viewer'),
    banned: integer('banned', { mode: 'boolean' }).default(false),
    banReason: text('banReason'),
    banExpires: integer('banExpires', { mode: 'timestamp' }),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull()
});

export const session = sqliteTable("session", {
    id: text("id").primaryKey(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId').notNull().references(() => user.id),
    impersonatedBy: text('impersonatedBy')
});

export const account = sqliteTable("account", {
    id: text("id").primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId').notNull().references(() => user.id),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull()
});

export const verification = sqliteTable("verification", {
    id: text("id").primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
});

// --- Enterprise Data Pipeline & Mirroring Cache --- //

export const syncState = sqliteTable("sync_state", {
    module: text("module").primaryKey(), // e.g., 'item', 'customer'
    lastSyncTimestamp: text("last_sync_timestamp"), // ISO string watermark
    lastPage: integer("last_page").default(1), // Checkpoint for initial load
    status: text("status").default('idle'), // 'idle', 'syncing', 'error'
    updatedAt: integer('updated_at', { mode: 'timestamp' })
});

export const item = sqliteTable("item", {
    id: integer("id").primaryKey(), // Accurate's internal numeric ID
    no: text("no").notNull(), // Item number/SKU
    name: text("name").notNull(),
    itemType: text("itemType"),
    unitPrice: integer("unitPrice"),
    rawData: text("raw_data", { mode: 'json' }), // Complete unprocessed payload
    lastUpdate: text("last_update") // Accurate's modified timestamp
});

export const customer = sqliteTable("customer", {
    id: integer("id").primaryKey(), // Accurate's internal numeric ID
    customerNo: text("customerNo").notNull(), 
    name: text("name").notNull(),
    balance: integer("balance"),
    rawData: text("raw_data", { mode: 'json' }), // Complete unprocessed payload
    lastUpdate: text("last_update") // Accurate's modified timestamp
});

export const idempotencyLog = sqliteTable("idempotency_log", {
    key: text("key").primaryKey(), 
    status: text("status").notNull(), 
    invoiceNo: text("invoiceNo"),
    customerNo: text("customerNo"),
    amount: real("amount"),
    transDate: text("transDate"),
    paymentMethod: text("paymentMethod"),
    source: text("source"),
    createdAt: integer('createdAt', { mode: 'timestamp' }),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
});
