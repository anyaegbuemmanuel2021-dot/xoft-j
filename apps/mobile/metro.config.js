const {getDefaultConfig, mergeConfig}=require('@react-native/metro-config');
module.exports=mergeConfig(getDefaultConfig(__dirname),{watchFolders:[require('path').resolve(__dirname,'../../packages/xoft-protocol')]});
