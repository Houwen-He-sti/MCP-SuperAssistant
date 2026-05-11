/** Type declarations for Vite ?raw imports of template files */
declare module '*.md?raw' {
  const content: string;
  export default content;
}
