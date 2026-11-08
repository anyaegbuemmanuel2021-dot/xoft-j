use serde::Serialize;
#[derive(Serialize)] struct Device { id:String, name:String, platform:String, trust:String, status:String }
#[tauri::command]
async fn connect_core(core_url:String, api_key:String)->Result<serde_json::Value,String>{
 let url=format!("{}/api/devices",core_url.trim_end_matches('/'));
 let client=reqwest::Client::new();
 let r=client.post(url).bearer_auth(api_key).json(&serde_json::json!({"name":"XOFT Desktop","platform":"desktop"})).send().await.map_err(|e|e.to_string())?;
 let status=r.status(); let body=r.text().await.map_err(|e|e.to_string())?;
 if !status.is_success(){return Err(format!("Core returned {}: {}",status,body));}
 serde_json::from_str(&body).map_err(|e|e.to_string())
}
#[cfg_attr(mobile,tauri::mobile_entry_point)]
pub fn run(){tauri::Builder::default().invoke_handler(tauri::generate_handler![connect_core]).run(tauri::generate_context!()).expect("error while running XOFT");}
