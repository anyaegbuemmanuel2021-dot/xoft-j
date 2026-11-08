export class ContextEngine {
 constructor({worldState,memory,activityLog}={}){this.worldState=worldState;this.memory=memory;this.activityLog=activityLog;}
 snapshot(){return{timestamp:new Date().toISOString(),world:this.worldState?.snapshot?.()??{},recentActivity:this.activityLog?.query?.({}).slice?.(-20)??[]};}
 describe(){return JSON.stringify(this.snapshot(),null,2);}
}
