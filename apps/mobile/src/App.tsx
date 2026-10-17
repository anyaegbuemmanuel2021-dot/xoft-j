import React,{useEffect,useState} from 'react';
import {SafeAreaView,View,Text,TextInput,Button,StyleSheet,Alert,ScrollView} from 'react-native';
import {XoftApi} from './api'; import {loadSettings,saveSettings} from './storage';

export default function App(){
 const [coreUrl,setCoreUrl]=useState('http://10.0.2.2:3000'); const [apiKey,setApiKey]=useState(''); const [deviceId,setDeviceId]=useState<string>(); const [status,setStatus]=useState('Not connected');
 useEffect(()=>{loadSettings().then(s=>{setCoreUrl(s.coreUrl);setApiKey(s.apiKey);setDeviceId(s.deviceId||undefined);});},[]);
 async function connect(){try{const api=new XoftApi(coreUrl,apiKey); let id=deviceId; if(!id){const d=await api.register('XOFT Mobile','android'); id=d.id; await saveSettings({coreUrl,apiKey,deviceId:id}); setDeviceId(id);} await api.capabilities(id,['system','applications','notifications','accessibility']); await api.heartbeat(id); setStatus(`Connected: ${id}`);}catch(e:any){setStatus('Connection failed');Alert.alert('XOFT',e?.message||String(e));}}
 return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.container}><Text style={styles.title}>XOFT Universal Agent</Text><Text style={styles.sub}>One client architecture for Android + iOS.</Text><Text>Core URL</Text><TextInput style={styles.input} value={coreUrl} onChangeText={setCoreUrl} autoCapitalize="none"/><Text>API Key</Text><TextInput style={styles.input} value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none"/><Button title="Connect & Register" onPress={connect}/><View style={styles.gap}/><Text>{status}</Text><Text style={styles.note}>Native Android/iOS capability modules plug into this shared client. Permissions are always OS-controlled.</Text></ScrollView></SafeAreaView>;
}
const styles=StyleSheet.create({safe:{flex:1},container:{padding:24,gap:10},title:{fontSize:30,fontWeight:'800'},sub:{marginBottom:20},input:{borderWidth:1,borderRadius:8,padding:12},gap:{height:12},note:{marginTop:20,lineHeight:20}});
