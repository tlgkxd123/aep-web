// Vite bundles `?worker&inline` imports into a Worker constructor with the script inlined.
declare module "*?worker&inline" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
