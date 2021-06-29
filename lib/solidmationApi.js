const request = require("request");
const utils = require("./utils");

class Solidmation {
  constructor(email, password, options) {
    if (!email || !password) {
      throw "Missing credentials";
      return;
    }

    this.options = options || {};
    this.auth = {
      email: email,
      password: password,
      token: null,
    };

    this.baseUrl =
      this.options.provider === "solidmation"
        ? "https://myhabeetatcloud-services.solidmation.com/"
        : "https://bgh-services.solidmation.com";
    this.apiUrl = `${this.baseUrl}/1.0`;
    this.cacheMs = 5000;
    this.queueDuration = 2000;

    this.homes = [];
    this.statusTimestamp = {};

    this.commandQueue = {};

    this.dataPacketSerials = {
      Home: 0,
      Groups: 0,
      Devices: 0,
      Endpoints: 0,
      EndpointValues: 0,
      Scenes: 0,
      Macros: 0,
      Alarms: 0,
    };
  }

  login() {
    return new Promise((resolve, reject) => {
      request.post(
        {
          url: `${this.baseUrl}/control/LoginPage.aspx/DoStandardLogin`,
          json: true,
          body: {
            user: this.auth.email,
            password: this.auth.password,
          },
        },
        (err, response) => {
          if (err) {
            reject(err);
            return;
          }

          if (response.body.d === "") {
            reject("Invalid Credentials");
            return;
          }

          var token = response.body.d;
          this.setToken(token);

          resolve(token);
        }
      );
    });
  }

  setToken(token = "") {
    this.auth = {
      ...this.auth,
      token,
    };
  }

  setDataPacketSerials(serials = {}) {
    return;
    this.dataPacketSerials = {
      ...this.dataPacketSerials,
      ...serials,
    };
  }

  async req(endpoint, body = {}) {
    if (!this.auth.token) {
      await this.login();
    }

    const reqBody = {
      ...body,
      token: { Token: this.auth.token },
    };

    return new Promise((resolve, reject) => {
      request.post(
        {
          url: `${this.apiUrl}${endpoint}`,
          json: true,
          body: reqBody,
        },
        function (err, response) {
          if (err) {
            reject(err);
            return;
          }

          resolve(response.body);
        }
      );
    });
  }

  async getDataPacket(homeId) {
    const data = await this.req("/HomeCloudService.svc/GetDataPacket", {
      homeID: homeId,
      serials: this.dataPacketSerials,
      timeOut: 10000,
    });

    this.setDataPacketSerials(data.GetDataPacketResult.NewSerials);
    this.setCache(homeId);
    return data.GetDataPacketResult;
  }

  async getHomes(filter = []) {
    const enumHomes = await this.req("/HomeCloudService.svc/EnumHomes");
    const { Homes } = enumHomes.EnumHomesResult;
    if (filter.length === 0) {
      this.homes = Homes;
      return this.homes;
    }

    this.homes = Homes.filter((home) => filter.includes(home.Description));
    return this.homes;
  }

  async getDevicesForHomeId(homeId) {
    let data = await this.getDataPacket(homeId);
    if (!data.Endpoints) {
      return [];
    }
    return utils.parseDevices(data);
  }

  async getDevices() {
    const a = await Promise.all(
      this.homes.map((home) => this.getDevicesForHomeId(home.HomeID))
    );
    this.devices = a.flat();
    return this.devices;
  }

  async updateHomeDevices(HomeID) {
    const fetchDevices = await this.getDevicesForHomeId(HomeID);

    this.devices = this.devices.map((oldDevice) => {
      const updatedDevice = fetchDevices.find(
        (row) => row.EndpointID === oldDevice.EndpointID
      );
      if (updatedDevice) {
        return updatedDevice;
      }

      return oldDevice;
    });

    return this.devices;
  }

  async getDeviceStatus(EndpointID, skipCache) {
    if( ! this.devices ) return;
    const device = this.devices.find((acc) => acc.EndpointID === EndpointID);
    if (!device) {
      return;
    }
    if (! skipCache && this.hasCache(device.HomeID)) {
      return device;
    }

    // When we renew the cache, make a single request and return all the promises together.
    // When opening Home, we can get 2-3 requests per device at the same time.
    if( ! this._deviceStatusRequest ) {
      this._deviceStatusRequest = this.updateHomeDevices(device.HomeID);
    }

    return new Promise((resolve, reject) => {
      this._deviceStatusRequest.then(() => {
        this._deviceStatusRequest = undefined;
        resolve(this.devices.find((acc) => acc.EndpointID === EndpointID));
      }).catch(e => {
        this._deviceStatusRequest = undefined;
        reject(e)
      });
    });
  }

  queueSetDeviceStatus(EndpointID, newStatus) {
    if( ! this.commandQueue[EndpointID] ) this.commandQueue[EndpointID] = { timeoutId: null, queue: [] };
    const deviceQueue = this.commandQueue[EndpointID];
    // Push things into the queue. We resolve
    deviceQueue.queue.push(newStatus);

    if( deviceQueue.timeoutId ) clearTimeout(deviceQueue.timeoutId);
    deviceQueue.timeoutId = setTimeout(() => {
      this.resolveCommandQueue(EndpointID)
    }, this.queueDuration);

    // Update the device cache with the new values
    const device = this.devices.find((acc) => acc.EndpointID === EndpointID);
    if( ! device ) return;
    device.endpointValues = {...device.endpointValues, ...newStatus };
  }

  async resolveCommandQueue(EndpointID) {
    const deviceQueue = this.commandQueue[EndpointID];
    if( ! deviceQueue.queue ) return null;
    let requestedStatus = { ...deviceQueue.queue[0] };

    for( const newStatus of deviceQueue.queue ) {
      // Just overwrite the previous values
      requestedStatus = {...requestedStatus, ...newStatus};
    }

    // Reset the queue
    if( deviceQueue.timeoutId ) { clearTimeout(deviceQueue.timeoutId); }
    this.commandQueue[EndpointID] = { timeoutId: null, queue: [] };

    // Only send a command if there's an actual difference in the current status
    const currentStatus = (await this.getDeviceStatus(EndpointID, true)).endpointValues;
    const modifiedKeys = Object.keys(requestedStatus).filter(k => currentStatus[k] != requestedStatus[k]);

    if( ! modifiedKeys ) return;
    this.setDeviceStatusNow(EndpointID, {...currentStatus, ...requestedStatus});
  }

  async setDeviceStatusNow(EndpointID, mode) {
    const device = this.devices.find((device) => device.EndpointID === EndpointID);
    const payload = {
      ...device.endpointValues,
      ...mode,
    };
    if( ! device ) throw Error(`Device with Endpoint ID #${endpointID} does not exist`);

    delete payload.currentTemp;
    delete payload.swingMode;
    if (payload.mode === 0) {
      payload.fanMode = 255;
      payload.flags = 255;
    }

    this.devices = this.devices.map((oldDevice) => {
      if (oldDevice.EndpointID === EndpointID) {
        oldDevice.endpointValues = payload;
      }

      return oldDevice;
    });

    const data = await this.req("/HomeCloudCommandService.svc/HVACSetModes", {
      ...payload,
      endpointID: device.EndpointID,
    });

    this.clearCache();

    return;
  }

  hasCache(HomeID) {
    if (!(HomeID in this.statusTimestamp)) {
      return false;
    }
    if (utils.timestamp() - this.statusTimestamp[HomeID] > this.cacheMs) {
      return false;
    }
    return true;
  }

  setCache(HomeID) {
    this.statusTimestamp[HomeID] = utils.timestamp();
  }

  clearCache() {
    this.statusTimestamp = {};
  }
}

module.exports = Solidmation;
