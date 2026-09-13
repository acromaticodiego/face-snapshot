/**
 * Configuracion de Jest.
 *
 * Identica a la de los servicios que ya tenian tests: los guards son
 * logica pura sobre un token, asi que se prueban sin base de datos ni
 * contenedores y corren en menos de un segundo. Eso es lo que hace que
 * se ejecuten de verdad en cada cambio y no solo en el CI.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\.spec\.ts$',
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  // Los guards son el PERIMETRO: lo unico que separa una peticion
  // cualquiera de poder administrar el sistema. No basta con "hay
  // algunos tests".
  coverageThreshold: {
    '**/{admin,auth}/*.guard.ts': {
      statements: 95,
      branches: 90,
      functions: 100,
      lines: 95,
    },
  },
};
