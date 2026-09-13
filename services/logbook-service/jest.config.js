/**
 * Configuración de Jest.
 *
 * Lo que se prueba aquí es lógica pura: la validación del periodo que
 * un parte declara cubrir y el resumen de accesos que se congela
 * dentro. Sin base de datos y sin contenedores, para que los tests
 * corran en segundos y se ejecuten de verdad en cada cambio.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\.spec\.ts$',
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!main.ts'],
  coverageDirectory: '../coverage',
};
