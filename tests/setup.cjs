// Repository calls are mocked. Never inherit a developer's real database in tests.
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/libretorio_unit_tests';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
