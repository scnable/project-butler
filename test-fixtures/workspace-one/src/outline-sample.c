typedef struct Packet {
    int value;
} Packet;

#if defined(USE_FAST_PATH)
void fast_path(void) {}
#else
void safe_path(void) {}
#endif
