module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.cjs'],
  silent: false,
  verbose: true,
  roots: ['<rootDir>/tests'], // Añadir la ubicación de tus archivos de prueba
  moduleNameMapper: {
    '^\\(src\\)/(.*)$': '<rootDir>/src/$1',
  },
};
