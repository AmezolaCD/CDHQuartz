import { pathToFileURL } from 'node:url';

/**
 * ¿Se está ejecutando este módulo directamente (y no importado)?
 *
 * Comparar contra `file://${process.argv[1]}` sólo acierta por casualidad en
 * Linux y macOS: en Windows la ruta llega como C:\ruta\script.js, con barras
 * invertidas y letra de unidad, nunca coincide, y el script termina sin hacer
 * nada ni imprimir un error. pathToFileURL normaliza las tres plataformas.
 */
export function esEjecutadoDirectamente(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return importMetaUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}
