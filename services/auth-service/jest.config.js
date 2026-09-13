/**
 * Configuracion de Jest.
 *
 * Identica a la de los servicios que ya tenian tests. El login se
 * prueba con dobles de Prisma y de argon2: sin base de datos ni
 * contenedores, en menos de un segundo, que es lo que hace que se
 * ejecuten de verdad en cada cambio y no solo en el CI.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\.spec\.ts$',
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  // El login es el perimetro de este servicio: emite el token que
  // abre /admin entero. No basta con "hay algunos tests".
  coverageThreshold: {
    '**/admin/admin-auth.service.ts': {
      statements: 95,
      branches: 90,
      functions: 100,
      lines: 95,
    },
  },
};
