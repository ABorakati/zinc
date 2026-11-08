// Size of Bun's libuv thread pool (DNS lookups, some file and process work). libuv starts 4 "libuv-worker" threads by default,
// and on Windows each one commits its whole 8 MB stack up front: 32 MB of commit charge for threads that mostly sleep. Two are
// enough for this app. Imported first by main.tsx, before anything can start the pool (libuv reads the variable once, when the pool
// starts). An explicit UV_THREADPOOL_SIZE in the environment wins.
process.env.UV_THREADPOOL_SIZE ??= "2";
