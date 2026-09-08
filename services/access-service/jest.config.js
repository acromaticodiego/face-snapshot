/**
 * Configuración de Jest.
 *
 * El motor de políticas es lógica pura y se prueba sin base de datos ni
 * contenedores: los tests corren en menos de un segundo, que es lo que
 * hace que se ejecuten de verdad en cada cambio.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\.spec\.ts$',
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  // El motor de autorización decide quién entra en un edificio: no
  // basta con "hay algunos tests".
  coverageThreshold: {
    // La ruta se compara contra los ficheros cubiertos, por eso el glob
    // en lugar de un directorio suelto.
    '**/policy/*.ts': {
      statements: 95,
      branches: 90,
      functions: 100,
      lines: 95,
    },
  },
};
