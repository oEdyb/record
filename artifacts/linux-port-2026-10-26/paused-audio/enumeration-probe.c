#include "pw_shim.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
 const char *lab=getenv("AGENT_LAB_RUNTIME"),*runtime=getenv("XDG_RUNTIME_DIR");
 if(!lab||!runtime||strcmp(lab,runtime)||!strstr(lab,"/agent-lab/")) return 2;
 char error[512]={0},sources[16384]={0};
 if(osc_pw_load(error,sizeof(error))!=0){fprintf(stderr,"%s\n",error);return 1;}
 int result=osc_pw_list_audio_sources(sources,sizeof(sources),error,sizeof(error));
 fprintf(stderr,"enumeration result=%d error=%s\n",result,error);return result==0?0:1;
}
