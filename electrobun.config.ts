export default {
  app: {
    name: "ForgeCouncil",
    identifier: "dev.forgecouncil.app",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "src/desktop/bun/index.ts",
    },
    views: {
      "main-ui": {
        entrypoint: "src/desktop/views/main-ui/index.ts",
      },
    },
    copy: {
      "src/desktop/views/main-ui/index.html": "views/main-ui/index.html",
      "src/desktop/views/main-ui/style.css": "views/main-ui/style.css",
    },
  },
};
