/*
 * orbitcam – Logitech QuickCam Orbit AF Controller for macOS
 *
 * Provides motorized Pan/Tilt/Reset control, LED switching, image adjustments,
 * a CLI utility, and an embedded HTTP/REST API server for modern macOS.
 *
 * Supported Hardware:
 *   Logitech QuickCam Orbit AF / Sphere AF (USB VID 0x046d, PID 0x0994)
 */

#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <pthread.h>
#include <mach-o/dyld.h>
#include <libgen.h>

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/usb/IOUSBLib.h>
#include <IOKit/IOCFPlugIn.h>

/* ── Hardware Identifiers ────────────────────────────────────────── */

#define LOGITECH_VID 0x046d
#define ORBIT_AF_PID 0x0994

/* UVC Standard Requests */
#define UVC_SET_CUR 0x01
#define UVC_GET_CUR 0x81
#define UVC_GET_MIN 0x82
#define UVC_GET_MAX 0x83
#define UVC_GET_RES 0x84
#define UVC_GET_LEN 0x85
#define UVC_GET_DEF 0x87

/* UVC Standard Entities */
#define UVC_CT_ID  0x01   /* Camera Terminal */
#define UVC_PU_ID  0x02   /* Processing Unit */

/* Processing Unit Selectors */
#define PU_BACKLIGHT_COMP       0x01
#define PU_BRIGHTNESS           0x02
#define PU_CONTRAST             0x03
#define PU_GAIN                 0x04
#define PU_POWER_LINE_FREQ      0x05
#define PU_SATURATION           0x07
#define PU_SHARPNESS            0x08
#define PU_WB_TEMP              0x0A
#define PU_WB_TEMP_AUTO         0x0B

/* Camera Terminal Selectors */
#define CT_AE_MODE              0x02
#define CT_EXPOSURE_TIME_ABS    0x04
#define CT_FOCUS_ABS            0x06
#define CT_FOCUS_AUTO           0x08

/* Logitech Extension Units for Orbit AF */
#define LOGITECH_MOTOR_UNIT     0x09
#define LXU_PANTILT_RELATIVE    0x01
#define LXU_PANTILT_RESET       0x02

#define LOGITECH_HW_CTRL_UNIT_A 0x0A
#define LOGITECH_HW_CTRL_UNIT_D 0x0D
#define LXU_HW_LED1             0x01

#define LXU_MOTOR_ENABLE        0x80
#define LXU_RESET_BOTH          0x03

#define LED_MODE_OFF            0x00
#define LED_MODE_ON             0x01
#define LED_MODE_BLINK          0x02
#define LED_MODE_AUTO           0x03

#define DEFAULT_HTTP_PORT       9090
#define HTTP_BUFFER_SIZE        65536

/* ── Settings Definition Table ───────────────────────────────────── */

typedef struct {
    const char *name;
    int unit;
    int selector;
    int size;
    int min;
    int max;
    int def;
} uvc_setting_def_t;

static const uvc_setting_def_t SETTINGS[] = {
    { "brightness",         UVC_PU_ID, PU_BRIGHTNESS,        2, 0, 255, 128 },
    { "contrast",           UVC_PU_ID, PU_CONTRAST,          2, 0, 255, 32  },
    { "saturation",         UVC_PU_ID, PU_SATURATION,        2, 0, 255, 32  },
    { "sharpness",          UVC_PU_ID, PU_SHARPNESS,         2, 0, 255, 224 },
    { "gain",               UVC_PU_ID, PU_GAIN,              2, 0, 255, 0   },
    { "backlight_comp",     UVC_PU_ID, PU_BACKLIGHT_COMP,    2, 0, 2,   1   },
    { "power_line_freq",    UVC_PU_ID, PU_POWER_LINE_FREQ,   1, 0, 2,   1   },
    { "white_balance_auto", UVC_PU_ID, PU_WB_TEMP_AUTO,      1, 0, 1,   1   },
    { "white_balance",      UVC_PU_ID, PU_WB_TEMP,           2, 2800, 6500, 4000 },
    { "exposure_auto",      UVC_CT_ID, CT_AE_MODE,           1, 1, 8,   8   },
    { "exposure",           UVC_CT_ID, CT_EXPOSURE_TIME_ABS, 4, 1, 10000, 166 },
    { "focus_auto",         UVC_CT_ID, CT_FOCUS_AUTO,        1, 0, 1,   1   },
    { "focus",              UVC_CT_ID, CT_FOCUS_ABS,         2, 0, 255, 0   },
};
#define NUM_SETTINGS (sizeof(SETTINGS) / sizeof(SETTINGS[0]))

static volatile sig_atomic_t g_running = 1;
static char g_web_dir[PATH_MAX] = {0};

static void sigint_handler(int sig) {
    (void)sig;
    g_running = 0;
}

/* ── IOKit Hardware Helpers ──────────────────────────────────────── */

static IOUSBDeviceInterface187 **find_orbit_device(void) {
    CFMutableDictionaryRef match = IOServiceMatching(kIOUSBDeviceClassName);
    if (!match) return NULL;

    SInt32 vid = LOGITECH_VID;
    SInt32 pid = ORBIT_AF_PID;
    CFNumberRef vNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &vid);
    CFNumberRef pNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &pid);
    CFDictionarySetValue(match, CFSTR(kUSBVendorID), vNum);
    CFDictionarySetValue(match, CFSTR(kUSBProductID), pNum);
    CFRelease(vNum);
    CFRelease(pNum);

    io_service_t svc = IOServiceGetMatchingService(kIOMainPortDefault, match);
    if (!svc) return NULL;

    IOCFPlugInInterface **plugIn = NULL;
    SInt32 score;
    kern_return_t kr = IOCreatePlugInInterfaceForService(
        svc, kIOUSBDeviceUserClientTypeID, kIOCFPlugInInterfaceID,
        &plugIn, &score);
    IOObjectRelease(svc);
    if (kr != kIOReturnSuccess || !plugIn) return NULL;

    IOUSBDeviceInterface187 **dev = NULL;
    (*plugIn)->QueryInterface(plugIn,
        CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID187), (LPVOID *)&dev);
    (*plugIn)->Release(plugIn);
    return dev;
}

static int uvc_device_request(uint8_t bmReqType, uint8_t bRequest,
                             int unitId, int selector, void *data, int length) {
    IOUSBDeviceInterface187 **dev = find_orbit_device();
    if (!dev) return -1;

    kern_return_t kr = (*dev)->USBDeviceOpen(dev);
    if (kr == (kern_return_t)0xe00002c5) { // kIOReturnExclusiveAccess
        kr = (*dev)->USBDeviceOpenSeize(dev);
    }
    if (kr != kIOReturnSuccess) {
        (*dev)->Release(dev);
        return -2;
    }

    IOUSBDevRequest req = {
        .bmRequestType = bmReqType,
        .bRequest      = bRequest,
        .wValue        = (uint16_t)(selector << 8),
        .wIndex        = (uint16_t)(unitId   << 8),
        .wLength       = (uint16_t)length,
        .wLenDone      = 0,
        .pData         = data,
    };

    kr = (*dev)->DeviceRequest(dev, &req);
    (*dev)->USBDeviceClose(dev);
    (*dev)->Release(dev);

    return (kr == kIOReturnSuccess) ? 0 : -3;
}

/* ── Motion & Control Routines ───────────────────────────────────── */

int orbitcam_pantilt(int pan_deg, int tilt_deg) {
    // Logitech QuickCam Orbit AF motor hardware orientation:
    // Physical resolution: 64 units per degree.
    // Sign convention verified on physical camera hardware:
    //   Negative pan units rotate clockwise (Pan Right)
    //   Positive pan units rotate counter-clockwise (Pan Left)
    //   Negative tilt units rotate up (Tilt Up)
    //   Positive tilt units rotate down (Tilt Down)
    // When pan_deg > 0 (Right), pan_units must be negative.
    // When tilt_deg > 0 (Up), tilt_units must be negative.
    int16_t pan_units = (int16_t)(-pan_deg * 64);
    int16_t tilt_units = (int16_t)(-tilt_deg * 64);

    uint8_t buf[4];
    buf[0] = (uint8_t)(pan_units & 0xFF);
    buf[1] = (uint8_t)((pan_units >> 8) & 0xFF);
    buf[2] = (uint8_t)(tilt_units & 0xFF);
    buf[3] = (uint8_t)((tilt_units >> 8) & 0xFF);

    return uvc_device_request(USBmakebmRequestType(kUSBOut, kUSBClass, kUSBInterface),
                              UVC_SET_CUR, LOGITECH_MOTOR_UNIT, LXU_PANTILT_RELATIVE, buf, 4);
}

int orbitcam_reset(void) {
    uint8_t val = LXU_RESET_BOTH;
    int ret = uvc_device_request(USBmakebmRequestType(kUSBOut, kUSBClass, kUSBInterface),
                                 UVC_SET_CUR, LOGITECH_MOTOR_UNIT, LXU_PANTILT_RESET, &val, 1);
    if (ret != 0) {
        uint8_t val2[2] = {LXU_RESET_BOTH, 0};
        ret = uvc_device_request(USBmakebmRequestType(kUSBOut, kUSBClass, kUSBInterface),
                                 UVC_SET_CUR, LOGITECH_MOTOR_UNIT, LXU_PANTILT_RESET, val2, 2);
    }
    return ret;
}

int orbitcam_led(int mode) {
    // Mode: 0 = Off, 1 = On, 2 = Blinking, 3 = Auto
    // Unit 0x0D is User HW Control XU (Unit 0x0A is Video Pipe/Codec)
    // Byte 0: mode, Byte 1: 0x00, Byte 2: frequency (20 = 1 Hz)
    uint8_t freq = (mode == LED_MODE_BLINK) ? 20 : 0x00;
    uint8_t buf[3] = {(uint8_t)mode, 0x00, freq};
    return uvc_device_request(USBmakebmRequestType(kUSBOut, kUSBClass, kUSBInterface),
                              UVC_SET_CUR, LOGITECH_HW_CTRL_UNIT_D, LXU_HW_LED1, buf, 3);
}

int orbitcam_get_led(void) {
    uint8_t buf[3] = {0};
    int ret = uvc_device_request(USBmakebmRequestType(kUSBIn, kUSBClass, kUSBInterface),
                                 UVC_GET_CUR, LOGITECH_HW_CTRL_UNIT_D, LXU_HW_LED1, buf, 3);
    if (ret == 0) return (int)buf[0];
    return LED_MODE_AUTO;
}

int orbitcam_get_setting(const uvc_setting_def_t *def, uint8_t requestType, int32_t *outVal) {
    int32_t raw = 0;
    int ret = uvc_device_request(USBmakebmRequestType(kUSBIn, kUSBClass, kUSBInterface),
                                 requestType, def->unit, def->selector, &raw, def->size);
    if (ret == 0 && outVal) {
        if (def->size == 1) *outVal = (int32_t)(int8_t)(raw & 0xFF);
        else if (def->size == 2) *outVal = (int32_t)(int16_t)(raw & 0xFFFF);
        else *outVal = raw;
    }
    return ret;
}

int orbitcam_set_setting(const uvc_setting_def_t *def, int32_t val) {
    int32_t sendVal = val;
    return uvc_device_request(USBmakebmRequestType(kUSBOut, kUSBClass, kUSBInterface),
                              UVC_SET_CUR, def->unit, def->selector, &sendVal, def->size);
}

const uvc_setting_def_t *orbitcam_find_setting(const char *name) {
    for (size_t i = 0; i < NUM_SETTINGS; i++) {
        if (strcasecmp(SETTINGS[i].name, name) == 0) {
            return &SETTINGS[i];
        }
    }
    return NULL;
}

int orbitcam_check_connected(void) {
    IOUSBDeviceInterface187 **dev = find_orbit_device();
    if (!dev) return 0;
    (*dev)->Release(dev);
    return 1;
}

/* ── JSON Helpers ────────────────────────────────────────────────── */

static NSString *get_status_json(void) {
    BOOL connected = orbitcam_check_connected();
    int ledMode = connected ? orbitcam_get_led() : LED_MODE_AUTO;
    NSString *ledStr = @"auto";
    if (ledMode == LED_MODE_OFF) ledStr = @"off";
    else if (ledMode == LED_MODE_ON) ledStr = @"on";
    else if (ledMode == LED_MODE_BLINK) ledStr = @"blink";

    NSDictionary *dict = @{
        @"connected": @(connected),
        @"device": @"Logitech QuickCam Orbit AF",
        @"vid": @"0x046d",
        @"pid": @"0x0994",
        @"pan_tilt_supported": @YES,
        @"led_supported": @YES,
        @"led_mode": ledStr,
        @"motor_unit": @(LOGITECH_MOTOR_UNIT),
        @"firmware_status": connected ? @"ready" : @"disconnected"
    };
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:dict options:NSJSONWritingPrettyPrinted error:&err];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static NSString *get_settings_json(void) {
    NSMutableDictionary *results = [NSMutableDictionary dictionary];
    for (size_t i = 0; i < NUM_SETTINGS; i++) {
        const uvc_setting_def_t *def = &SETTINGS[i];
        int32_t cur = 0, min = def->min, max = def->max, step = 1, dflt = def->def;

        if (orbitcam_get_setting(def, UVC_GET_CUR, &cur) != 0) cur = def->def;
        int32_t tmp = 0;
        if (orbitcam_get_setting(def, UVC_GET_MIN, &tmp) == 0) min = tmp;
        if (orbitcam_get_setting(def, UVC_GET_MAX, &tmp) == 0) max = tmp;
        if (orbitcam_get_setting(def, UVC_GET_RES, &tmp) == 0 && tmp > 0) step = tmp;
        if (orbitcam_get_setting(def, UVC_GET_DEF, &tmp) == 0) dflt = tmp;

        results[@(def->name)] = @{
            @"value": @(cur),
            @"min": @(min),
            @"max": @(max),
            @"step": @(step),
            @"default": @(dflt)
        };
    }

    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:results options:NSJSONWritingPrettyPrinted error:&err];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

/* ── HTTP Server Implementation ──────────────────────────────────── */

static const char *get_mime_type(const char *path) {
    const char *ext = strrchr(path, '.');
    if (!ext) return "application/octet-stream";
    if (strcasecmp(ext, ".html") == 0 || strcasecmp(ext, ".htm") == 0) return "text/html; charset=utf-8";
    if (strcasecmp(ext, ".css") == 0) return "text/css; charset=utf-8";
    if (strcasecmp(ext, ".js") == 0) return "application/javascript; charset=utf-8";
    if (strcasecmp(ext, ".json") == 0) return "application/json; charset=utf-8";
    if (strcasecmp(ext, ".png") == 0) return "image/png";
    if (strcasecmp(ext, ".jpg") == 0 || strcasecmp(ext, ".jpeg") == 0) return "image/jpeg";
    if (strcasecmp(ext, ".svg") == 0) return "image/svg+xml";
    if (strcasecmp(ext, ".ico") == 0) return "image/x-icon";
    return "application/octet-stream";
}

static void send_http_response(int client_fd, int status, const char *status_msg,
                               const char *content_type, const void *body, size_t body_len) {
    char header[1024];
    int header_len = snprintf(header, sizeof(header),
        "HTTP/1.1 %d %s\r\n"
        "Server: OrbitcamLDAF/1.0\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "Connection: close\r\n"
        "\r\n",
        status, status_msg, content_type, body_len);

    send(client_fd, header, (size_t)header_len, 0);
    if (body && body_len > 0) {
        send(client_fd, body, body_len, 0);
    }
}

static void handle_client(int client_fd) {
    char req_buf[HTTP_BUFFER_SIZE];
    ssize_t nread = recv(client_fd, req_buf, sizeof(req_buf) - 1, 0);
    if (nread <= 0) {
        close(client_fd);
        return;
    }
    req_buf[nread] = '\0';

    char method[16] = {0};
    char url[512] = {0};
    char version[16] = {0};
    sscanf(req_buf, "%15s %511s %15s", method, url, version);

    // Clean query params if any
    char *query = strchr(url, '?');
    if (query) *query = '\0';

    // CORS preflight
    if (strcasecmp(method, "OPTIONS") == 0) {
        send_http_response(client_fd, 204, "No Content", "text/plain", "", 0);
        close(client_fd);
        return;
    }

    // Locate request body
    char *body = strstr(req_buf, "\r\n\r\n");
    if (body) body += 4;
    else body = "";

    @autoreleasepool {
        if (strcasecmp(method, "GET") == 0 && strcmp(url, "/api/status") == 0) {
            NSString *json = get_status_json();
            NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
            send_http_response(client_fd, 200, "OK", "application/json", [data bytes], [data length]);
        }
        else if (strcasecmp(method, "GET") == 0 && strcmp(url, "/api/settings") == 0) {
            NSString *json = get_settings_json();
            NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
            send_http_response(client_fd, 200, "OK", "application/json", [data bytes], [data length]);
        }
        else if (strcasecmp(method, "POST") == 0 && strcmp(url, "/api/ptz") == 0) {
            NSData *bodyData = [NSData dataWithBytes:body length:strlen(body)];
            NSError *err = nil;
            NSDictionary *dict = [NSJSONSerialization JSONObjectWithData:bodyData options:0 error:&err];
            int pan = dict && dict[@"pan"] ? [dict[@"pan"] intValue] : 0;
            int tilt = dict && dict[@"tilt"] ? [dict[@"tilt"] intValue] : 0;

            int ret = orbitcam_pantilt(pan, tilt);
            NSDictionary *resp = @{ @"success": @(ret == 0), @"code": @(ret), @"pan": @(pan), @"tilt": @(tilt) };
            NSData *outData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];
            send_http_response(client_fd, ret == 0 ? 200 : 500, ret == 0 ? "OK" : "Error",
                               "application/json", [outData bytes], [outData length]);
        }
        else if (strcasecmp(method, "POST") == 0 && strcmp(url, "/api/reset") == 0) {
            int ret = orbitcam_reset();
            NSDictionary *resp = @{ @"success": @(ret == 0), @"code": @(ret), @"action": @"reset" };
            NSData *outData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];
            send_http_response(client_fd, ret == 0 ? 200 : 500, ret == 0 ? "OK" : "Error",
                               "application/json", [outData bytes], [outData length]);
        }
        else if (strcasecmp(method, "GET") == 0 && strcmp(url, "/api/led") == 0) {
            int mode = orbitcam_get_led();
            NSString *modeStr = @"auto";
            if (mode == LED_MODE_OFF) modeStr = @"off";
            else if (mode == LED_MODE_ON) modeStr = @"on";
            else if (mode == LED_MODE_BLINK) modeStr = @"blink";
            NSDictionary *resp = @{ @"mode": modeStr, @"value": @(mode) };
            NSData *outData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];
            send_http_response(client_fd, 200, "OK", "application/json", [outData bytes], [outData length]);
        }
        else if (strcasecmp(method, "POST") == 0 && strcmp(url, "/api/led") == 0) {
            NSData *bodyData = [NSData dataWithBytes:body length:strlen(body)];
            NSDictionary *dict = [NSJSONSerialization JSONObjectWithData:bodyData options:0 error:nil];
            NSString *modeStr = dict[@"mode"] ?: @"auto";
            int mode = LED_MODE_AUTO;
            if ([modeStr isEqualToString:@"off"]) mode = LED_MODE_OFF;
            else if ([modeStr isEqualToString:@"on"]) mode = LED_MODE_ON;
            else if ([modeStr isEqualToString:@"blink"]) mode = LED_MODE_BLINK;

            int ret = orbitcam_led(mode);
            NSDictionary *resp = @{ @"success": @(ret == 0), @"code": @(ret), @"mode": modeStr };
            NSData *outData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];
            send_http_response(client_fd, ret == 0 ? 200 : 500, ret == 0 ? "OK" : "Error",
                               "application/json", [outData bytes], [outData length]);
        }
        else if (strcasecmp(method, "POST") == 0 && strcmp(url, "/api/setting") == 0) {
            NSData *bodyData = [NSData dataWithBytes:body length:strlen(body)];
            NSDictionary *dict = [NSJSONSerialization JSONObjectWithData:bodyData options:0 error:nil];
            NSString *name = dict[@"name"];
            int val = [dict[@"value"] intValue];

            const uvc_setting_def_t *def = name ? orbitcam_find_setting([name UTF8String]) : NULL;
            if (!def) {
                const char *errJson = "{\"error\": \"unknown setting\"}";
                send_http_response(client_fd, 400, "Bad Request", "application/json", errJson, strlen(errJson));
            } else {
                int ret = orbitcam_set_setting(def, val);
                NSDictionary *resp = @{ @"success": @(ret == 0), @"setting": name, @"value": @(val) };
                NSData *outData = [NSJSONSerialization dataWithJSONObject:resp options:0 error:nil];
                send_http_response(client_fd, ret == 0 ? 200 : 500, ret == 0 ? "OK" : "Error",
                                   "application/json", [outData bytes], [outData length]);
            }
        }
        else if (strcasecmp(method, "POST") == 0 && strcmp(url, "/api/settings/reset") == 0) {
            for (size_t i = 0; i < NUM_SETTINGS; i++) {
                orbitcam_set_setting(&SETTINGS[i], SETTINGS[i].def);
            }
            const char *okJson = "{\"success\": true, \"reset\": \"defaults\"}";
            send_http_response(client_fd, 200, "OK", "application/json", okJson, strlen(okJson));
        }
        else {
            // Serve static files
            const char *rel_path = url;
            if (strcmp(rel_path, "/") == 0) rel_path = "/index.html";

            char full_path[PATH_MAX];
            snprintf(full_path, sizeof(full_path), "%s%s", g_web_dir, rel_path);

            FILE *f = fopen(full_path, "rb");
            if (!f) {
                const char *notFound = "<html><body><h1>404 Not Found</h1></body></html>";
                send_http_response(client_fd, 404, "Not Found", "text/html", notFound, strlen(notFound));
            } else {
                fseek(f, 0, SEEK_END);
                long fsize = ftell(f);
                fseek(f, 0, SEEK_SET);

                void *fdata = malloc((size_t)fsize);
                if (fdata && fread(fdata, 1, (size_t)fsize, f) == (size_t)fsize) {
                    send_http_response(client_fd, 200, "OK", get_mime_type(full_path), fdata, (size_t)fsize);
                } else {
                    const char *err500 = "<html><body><h1>500 Internal Error</h1></body></html>";
                    send_http_response(client_fd, 500, "Error", "text/html", err500, strlen(err500));
                }
                free(fdata);
                fclose(f);
            }
        }
    }
    close(client_fd);
}

static void *client_thread(void *arg) {
    int client_fd = (int)(intptr_t)arg;
    handle_client(client_fd);
    return NULL;
}

int run_http_server(int port) {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("socket");
        return 1;
    }

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons((uint16_t)port);

    if (bind(server_fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        perror("bind");
        close(server_fd);
        return 1;
    }

    if (listen(server_fd, 16) < 0) {
        perror("listen");
        close(server_fd);
        return 1;
    }

    printf("=========================================================\n");
    printf(" 🎥 OrbitcamLDAF Controller Server\n");
    printf(" Logitech QuickCam Orbit AF Motion & Vision Daemon\n");
    printf("=========================================================\n");
    printf(" Server listening at: http://localhost:%d\n", port);
    printf(" Serving web assets from: %s\n", g_web_dir);
    printf(" Press Ctrl+C to stop.\n\n");

    signal(SIGINT, sigint_handler);
    signal(SIGTERM, sigint_handler);

    while (g_running) {
        struct sockaddr_in client_addr;
        socklen_t addr_len = sizeof(client_addr);

        fd_set read_fds;
        FD_ZERO(&read_fds);
        FD_SET(server_fd, &read_fds);

        struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };
        int sel = select(server_fd + 1, &read_fds, NULL, NULL, &tv);
        if (sel <= 0) continue;

        int client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &addr_len);
        if (client_fd >= 0) {
            pthread_t tid;
            pthread_create(&tid, NULL, client_thread, (void *)(intptr_t)client_fd);
            pthread_detach(tid);
        }
    }

    printf("\nShutting down server...\n");
    close(server_fd);
    return 0;
}

/* ── Asset Discovery ─────────────────────────────────────────────── */

static void resolve_web_dir(void) {
    char exe_path[PATH_MAX];
    uint32_t size = sizeof(exe_path);
    if (_NSGetExecutablePath(exe_path, &size) == 0) {
        char real_exe[PATH_MAX];
        if (realpath(exe_path, real_exe)) {
            char *dir = dirname(real_exe);
            // Try ../src/web
            char candidate[PATH_MAX];
            snprintf(candidate, sizeof(candidate), "%s/../src/web", dir);
            struct stat st;
            if (stat(candidate, &st) == 0 && S_ISDIR(st.st_mode)) {
                realpath(candidate, g_web_dir);
                return;
            }
            // Try web in same dir
            snprintf(candidate, sizeof(candidate), "%s/web", dir);
            if (stat(candidate, &st) == 0 && S_ISDIR(st.st_mode)) {
                realpath(candidate, g_web_dir);
                return;
            }
        }
    }

    // Fallback to current working directory ./src/web
    struct stat st;
    if (stat("./src/web", &st) == 0 && S_ISDIR(st.st_mode)) {
        realpath("./src/web", g_web_dir);
    } else {
        realpath(".", g_web_dir);
    }
}

/* ── CLI Usage & Entrypoint ──────────────────────────────────────── */

static void print_usage(const char *prog) {
    printf("OrbitcamLDAF – Logitech QuickCam Orbit AF Motion Control\n\n");
    printf("Usage: %s <command> [options]\n\n", prog);
    printf("Commands:\n");
    printf("  serve [port]              Start local web & REST API server (default: 9090)\n");
    printf("  reset                     Center and calibrate pan/tilt motors to home position\n");
    printf("  pan <steps>               Pan left (-steps) or right (+steps)\n");
    printf("  tilt <steps>              Tilt down (-steps) or up (+steps)\n");
    printf("  pantilt <pan> <tilt>      Pan and tilt simultaneously\n");
    printf("  led <off|on|blink|auto>   Set camera indicator LED mode\n");
    printf("  status                    Display device connection and hardware details\n");
    printf("  settings                  List all image/processing settings\n");
    printf("  get <setting>             Read value of a setting\n");
    printf("  set <setting> <value>     Write value of a setting\n");
    printf("  help                      Display this help screen\n\n");
    printf("Examples:\n");
    printf("  %s serve                  # Starts UI at http://localhost:9090\n", prog);
    printf("  %s reset                  # Centers the camera\n", prog);
    printf("  %s pan 3                  # Pans right by 3 steps\n", prog);
    printf("  %s tilt 2                 # Tilts up by 2 steps\n", prog);
    printf("  %s led blink              # Blinks the camera ring light\n", prog);
}

int main(int argc, char *argv[]) {
    resolve_web_dir();

    if (argc < 2) {
        return run_http_server(DEFAULT_HTTP_PORT);
    }

    const char *cmd = argv[1];

    if (strcmp(cmd, "serve") == 0 || strcmp(cmd, "server") == 0) {
        int port = DEFAULT_HTTP_PORT;
        if (argc >= 3) port = atoi(argv[2]);
        if (port <= 0) port = DEFAULT_HTTP_PORT;
        return run_http_server(port);
    }
    else if (strcmp(cmd, "reset") == 0 || strcmp(cmd, "home") == 0) {
        printf("Calibrating and centering Logitech Orbit AF motors...\n");
        int ret = orbitcam_reset();
        if (ret == 0) {
            printf("✓ Camera motors centered.\n");
            return 0;
        } else {
            fprintf(stderr, "✗ Error: Failed to reset motors (code %d). Is the camera connected?\n", ret);
            return 1;
        }
    }
    else if (strcmp(cmd, "pan") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Usage: %s pan <steps>\n", argv[0]);
            return 1;
        }
        int pan = atoi(argv[2]);
        int ret = orbitcam_pantilt(pan, 0);
        if (ret == 0) {
            printf("✓ Panned %s by %d steps.\n", pan >= 0 ? "right" : "left", abs(pan));
            return 0;
        } else {
            fprintf(stderr, "✗ Error: Failed to pan (code %d)\n", ret);
            return 1;
        }
    }
    else if (strcmp(cmd, "tilt") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Usage: %s tilt <steps>\n", argv[0]);
            return 1;
        }
        int tilt = atoi(argv[2]);
        int ret = orbitcam_pantilt(0, tilt);
        if (ret == 0) {
            printf("✓ Tilted %s by %d steps.\n", tilt >= 0 ? "up" : "down", abs(tilt));
            return 0;
        } else {
            fprintf(stderr, "✗ Error: Failed to tilt (code %d)\n", ret);
            return 1;
        }
    }
    else if (strcmp(cmd, "pantilt") == 0) {
        if (argc < 4) {
            fprintf(stderr, "Usage: %s pantilt <pan> <tilt>\n", argv[0]);
            return 1;
        }
        int pan = atoi(argv[2]);
        int tilt = atoi(argv[3]);
        int ret = orbitcam_pantilt(pan, tilt);
        if (ret == 0) {
            printf("✓ Moved pan: %d, tilt: %d.\n", pan, tilt);
            return 0;
        } else {
            fprintf(stderr, "✗ Error: Failed to move (code %d)\n", ret);
            return 1;
        }
    }
    else if (strcmp(cmd, "led") == 0) {
        if (argc < 3) {
            fprintf(stderr, "Usage: %s led <off|on|blink|auto>\n", argv[0]);
            return 1;
        }
        const char *m = argv[2];
        int mode = LED_MODE_AUTO;
        if (strcasecmp(m, "off") == 0) mode = LED_MODE_OFF;
        else if (strcasecmp(m, "on") == 0) mode = LED_MODE_ON;
        else if (strcasecmp(m, "blink") == 0) mode = LED_MODE_BLINK;
        else if (strcasecmp(m, "auto") == 0) mode = LED_MODE_AUTO;
        else {
            fprintf(stderr, "Invalid LED mode '%s'. Use off, on, blink, or auto.\n", m);
            return 1;
        }
        int ret = orbitcam_led(mode);
        if (ret == 0) {
            printf("✓ LED set to: %s\n", m);
            return 0;
        } else {
            fprintf(stderr, "✗ Error setting LED (code %d)\n", ret);
            return 1;
        }
    }
    else if (strcmp(cmd, "status") == 0) {
        BOOL connected = orbitcam_check_connected();
        printf("--- Logitech QuickCam Orbit AF Status ---\n");
        printf("Device Model:  Logitech QuickCam Orbit AF (046d:0994)\n");
        printf("Connection:    %s\n", connected ? "Connected (Ready)" : "Not Found / Disconnected");
        printf("PTZ Motors:    Extension Unit 0x09 Available\n");
        printf("LED Ring:      Available\n");
        printf("Web Assets:    %s\n", g_web_dir);
        return connected ? 0 : 1;
    }
    else if (strcmp(cmd, "settings") == 0) {
        printf("%-20s %-10s %-10s %-10s %-10s\n", "Setting", "Current", "Min", "Max", "Default");
        printf("----------------------------------------------------------------\n");
        for (size_t i = 0; i < NUM_SETTINGS; i++) {
            const uvc_setting_def_t *def = &SETTINGS[i];
            int32_t cur = 0, min = def->min, max = def->max, dflt = def->def;
            if (orbitcam_get_setting(def, UVC_GET_CUR, &cur) != 0) cur = -1;
            int32_t tmp = 0;
            if (orbitcam_get_setting(def, UVC_GET_MIN, &tmp) == 0) min = tmp;
            if (orbitcam_get_setting(def, UVC_GET_MAX, &tmp) == 0) max = tmp;
            if (orbitcam_get_setting(def, UVC_GET_DEF, &tmp) == 0) dflt = tmp;
            printf("%-20s %-10d %-10d %-10d %-10d\n", def->name, cur, min, max, dflt);
        }
        return 0;
    }
    else if (strcmp(cmd, "get") == 0 && argc >= 3) {
        const uvc_setting_def_t *def = orbitcam_find_setting(argv[2]);
        if (!def) {
            fprintf(stderr, "Unknown setting '%s'\n", argv[2]);
            return 1;
        }
        int32_t val = 0;
        if (orbitcam_get_setting(def, UVC_GET_CUR, &val) == 0) {
            printf("%d\n", val);
            return 0;
        } else {
            fprintf(stderr, "Failed to read setting '%s'\n", argv[2]);
            return 1;
        }
    }
    else if (strcmp(cmd, "set") == 0 && argc >= 4) {
        const uvc_setting_def_t *def = orbitcam_find_setting(argv[2]);
        if (!def) {
            fprintf(stderr, "Unknown setting '%s'\n", argv[2]);
            return 1;
        }
        int val = atoi(argv[3]);
        if (orbitcam_set_setting(def, val) == 0) {
            printf("✓ Set %s = %d\n", argv[2], val);
            return 0;
        } else {
            fprintf(stderr, "Failed to write setting '%s'\n", argv[2]);
            return 1;
        }
    }
    else if (strcmp(cmd, "help") == 0 || strcmp(cmd, "--help") == 0 || strcmp(cmd, "-h") == 0) {
        print_usage(argv[0]);
        return 0;
    }
    else {
        fprintf(stderr, "Unknown command: %s\n\n", cmd);
        print_usage(argv[0]);
        return 1;
    }

    return 0;
}
