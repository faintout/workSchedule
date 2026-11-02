import { createApp } from './app.js';

const { app } = await createApp({
  databasePath: process.env.DATABASE_PATH ?? './data/schedule.sqlite',
  adminPassword: process.env.ADMIN_PASSWORD,
  secureCookies: process.env.COOKIE_SECURE === 'true',
  logger: true,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
try {
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
