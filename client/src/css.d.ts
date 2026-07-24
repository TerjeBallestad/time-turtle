// Side-effect CSS imports (Vite handles them; tsc only needs them to resolve).
declare module '*.css';

// CSS Modules — default export maps class names to their hashed strings.
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
