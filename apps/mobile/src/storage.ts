import AsyncStorage from '@react-native-async-storage/async-storage';
export async function loadSettings(){return {coreUrl:(await AsyncStorage.getItem('coreUrl'))||'http://10.0.2.2:3000',apiKey:(await AsyncStorage.getItem('apiKey'))||'',deviceId:await AsyncStorage.getItem('deviceId')};}
export async function saveSettings(s:{coreUrl:string;apiKey:string;deviceId?:string}){await AsyncStorage.multiSet([['coreUrl',s.coreUrl],['apiKey',s.apiKey],['deviceId',s.deviceId||'']]);}
