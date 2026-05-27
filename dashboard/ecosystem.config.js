module.exports = {
  apps: [{
    name: "bravonoid-dashboard",
    cwd: __dirname,
    script: "server.js",
    watch: false,
    env: {
      PORT: 3456
    }
  }]
};
