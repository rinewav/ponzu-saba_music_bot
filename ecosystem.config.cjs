module.exports = {
  apps: [
    {
      name: 'runrunpomi',
      script: 'dist/manager.js',
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
