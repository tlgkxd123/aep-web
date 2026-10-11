// Vite imports `?raw` files as their text.
declare module "*?raw" {
  const text: string;
  export default text;
}
