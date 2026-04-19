const presets = ['@babel/preset-env', '@babel/preset-react', '@babel/preset-typescript'];
const plugins = [
  '@babel/plugin-transform-regenerator',
  '@babel/plugin-proposal-class-properties',
  '@babel/plugin-proposal-object-rest-spread',
  '@babel/plugin-transform-runtime',
];

module.exports = { presets, plugins };
