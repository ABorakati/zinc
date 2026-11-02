// Build-time only (scripts/build.ts runs the Solid JSX transform through Babel); neither package ships types.
declare module "@babel/core";
declare module "babel-preset-solid";
declare module "@babel/preset-typescript";
