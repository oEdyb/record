#define _POSIX_C_SOURCE 200809L
#include "pw_shim.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static int started;
static void samples(void *user, const float *pcm, uint32_t count, uint64_t cycle) {
    (void)user;
    if (!started) { fprintf(stderr,"FIRST %llu\n", (unsigned long long)cycle); fflush(stderr); started=1; }
    if (fwrite(pcm,sizeof(float),count,stdout)!=count) { fputs("PCM write failed\n",stderr); _Exit(3); }
}
static void state(void *user,const char *state_name,const char *error) {
    (void)user; fprintf(stderr,"STATE %s %s\n",state_name,error?error:""); fflush(stderr);
}
int main(int argc,char **argv) {
    const char *runtime=getenv("AGENT_LAB_RUNTIME"), *xdg=getenv("XDG_RUNTIME_DIR");
    char expected[128];snprintf(expected,sizeof(expected),"/run/user/%lu/agent-lab/",(unsigned long)getuid());
    if(!runtime||!xdg||strcmp(runtime,xdg)||strncmp(runtime,expected,strlen(expected))) { fputs("Private lab required\n",stderr);return 2; }
    if(argc!=3)return 2;
    char error[1024]={0};if(osc_pw_load(error,sizeof(error))!=0) { fprintf(stderr,"%s\n",error);return 1; }
    struct osc_pw_audio_callbacks callbacks={.user=NULL,.on_samples=samples,.on_state=state};
    struct osc_pw_audio *audio=osc_pw_audio_start(strcmp(argv[1],"--default")?argv[1]:NULL,0,48000,2,&callbacks,error,sizeof(error));
    if(!audio) { fprintf(stderr,"%s\n",error);return 1; }
    sleep((unsigned)atoi(argv[2]));osc_pw_audio_stop(audio);return fflush(stdout)==0?0:3;
}
