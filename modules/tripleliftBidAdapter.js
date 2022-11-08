import { tryAppendQueryString, logMessage, logError, isEmpty, isStr, isPlainObject, isArray, logWarn } from '../src/utils.js';
import { BANNER, VIDEO, NATIVE } from '../src/mediaTypes.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { config } from '../src/config.js';
import { getStorageManager } from '../src/storageManager.js';

const GVLID = 28;
const BIDDER_CODE = 'triplelift';
const STR_ENDPOINT = 'https://tlx.3lift.com/header/auction?';
const STR_ENDPOINT_NATIVE = 'https://tlx.3lift.com/header_native/auction?';
let gdprApplies = true;
let consentString = null;
export const storage = getStorageManager({gvlid: GVLID, bidderCode: BIDDER_CODE});
const BANNER_TIME_TO_LIVE = 300;
const INSTREAM_TIME_TO_LIVE = 3600;

export const tripleliftAdapterSpec = {
  gvlid: GVLID,
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER, VIDEO, NATIVE],
  isBidRequestValid: function (bid) {
    return typeof bid.params.inventoryCode !== 'undefined';
  },

  buildRequests: function (bidRequests, bidderRequest) {
    let endpoints = {
      standard: STR_ENDPOINT,
      native: STR_ENDPOINT_NATIVE
    };
    let data = _filterData(_buildPostBody(bidRequests, bidderRequest));

    for (const prop in endpoints) {
      endpoints[prop] = tryAppendQueryString(endpoints[prop], 'lib', 'prebid');
      endpoints[prop] = tryAppendQueryString(endpoints[prop], 'v', '$prebid.version$');

      if (bidderRequest && bidderRequest.refererInfo) {
        let referrer = bidderRequest.refererInfo.page;
        endpoints[prop] = tryAppendQueryString(endpoints[prop], 'referrer', referrer);
      }

      if (bidderRequest && bidderRequest.timeout) {
        endpoints[prop] = tryAppendQueryString(
          endpoints[prop],
          'tmax',
          bidderRequest.timeout
        );
      }

      if (bidderRequest && bidderRequest.gdprConsent) {
        if (typeof bidderRequest.gdprConsent.gdprApplies !== 'undefined') {
          gdprApplies = bidderRequest.gdprConsent.gdprApplies;
          endpoints[prop] = tryAppendQueryString(
            endpoints[prop],
            'gdpr',
            gdprApplies.toString()
          );
        }
        if (typeof bidderRequest.gdprConsent.consentString !== 'undefined') {
          consentString = bidderRequest.gdprConsent.consentString;
          endpoints[prop] = tryAppendQueryString(endpoints[prop], 'cmp_cs', consentString);
        }
      }

      if (bidderRequest && bidderRequest.uspConsent) {
        endpoints[prop] = tryAppendQueryString(
          endpoints[prop],
          'us_privacy',
          bidderRequest.uspConsent
        );
      }

      if (config.getConfig('coppa') === true) {
        endpoints[prop] = tryAppendQueryString(endpoints[prop], 'coppa', true);
      }

      if (endpoints[prop].lastIndexOf('&') === endpoints[prop].length - 1) {
        endpoints[prop] = endpoints[prop].substring(0, endpoints[prop].length - 1);
      }
      logMessage(`${prop} request built: ${endpoints[prop]}`);
    }

    // Endpoint is not called if data is not available for it
    return Object.keys(data).map(mediaType => {
      return {
        method: 'POST',
        url: endpoints[mediaType],
        data: data[mediaType],
        bidderRequest
      };
    });
  },

  interpretResponse: function (serverResponse, {bidderRequest}) {
    let bids = serverResponse.body.bids || [];
    let { standardUnits, nativeUnits } = _splitAdUnits(bidderRequest.bids);

    return bids.map(function (bid) {
      return _buildResponseObject(bid, standardUnits, nativeUnits);
    });
  },

  getUserSyncs: function (syncOptions, responses, gdprConsent, usPrivacy) {
    let syncType = _getSyncType(syncOptions);
    if (!syncType) return;

    let syncEndpoint = 'https://eb2.3lift.com/sync?';

    if (syncType === 'image') {
      syncEndpoint = tryAppendQueryString(syncEndpoint, 'px', 1);
      syncEndpoint = tryAppendQueryString(syncEndpoint, 'src', 'prebid');
    }

    if (consentString !== null) {
      syncEndpoint = tryAppendQueryString(syncEndpoint, 'gdpr', gdprApplies);
      syncEndpoint = tryAppendQueryString(syncEndpoint, 'cmp_cs', consentString);
    }

    if (usPrivacy) {
      syncEndpoint = tryAppendQueryString(syncEndpoint, 'us_privacy', usPrivacy);
    }

    return [
      {
        type: syncType,
        url: syncEndpoint
      }
    ];
  }
};

function _getSyncType(syncOptions) {
  if (!syncOptions) return;
  if (syncOptions.iframeEnabled) return 'iframe';
  if (syncOptions.pixelEnabled) return 'image';
}

function _splitAdUnits(bidRequests) {
  let standardUnits = []
  let nativeUnits = []
  bidRequests.forEach(bid => {
    if (bid.mediaTypes.banner || bid.mediaTypes.video) {
      standardUnits.push(bid)
    } else if (bid.mediaTypes.native && !bid.mediaTypes.banner && !bid.mediaTypes.video) {
      nativeUnits.push(bid)
    }
  })

  return {
    standardUnits,
    nativeUnits
  }
}

function _buildPostBody(bidRequests, bidderRequest) {
  let { standardUnits, nativeUnits } = _splitAdUnits(bidRequests);
  let standard = {};
  let native = {};
  let { schain } = bidRequests[0];
  const globalFpd = _getGlobalFpd(bidderRequest);

  // Returns empty array if no units; which will later be filtered out by _filterData
  standard.imp = standardUnits.map((bidRequest, index) => {
    let imp = {
      id: index,
      tagid: bidRequest.params.inventoryCode,
      floor: _getFloor(bidRequest)
    };
    // remove the else to support multi-imp
    if (_isInstreamBidRequest(bidRequest)) {
      imp.video = _getORTBVideo(bidRequest);
    } else if (bidRequest.mediaTypes.banner) {
      imp.banner = { format: _sizes(bidRequest.sizes) };
    }
    if (!isEmpty(bidRequest.ortb2Imp)) {
      imp.fpd = _getAdUnitFpd(bidRequest.ortb2Imp);
    }
    return imp;
  });

  // Returns empty array if no units; which will later be filtered out by _filterData
  native.imp = nativeUnits.map((bidRequest, index) => {
    let imp = {
      id: index,
      tagid: bidRequest.params.inventoryCode,
      floor: _getFloor(bidRequest),
      native: bidRequest.nativeParams,
      sizes: _sizes([[1, 1]])
    };

    if (!isEmpty(bidRequest.ortb2Imp)) {
      imp.fpd = _getAdUnitFpd(bidRequest.ortb2Imp);
    }

    return imp;
  });

  let eids = [
    ...getUnifiedIdEids([bidRequests[0]]),
    ...getIdentityLinkEids([bidRequests[0]]),
    ...getCriteoEids([bidRequests[0]]),
    ...getPubCommonEids([bidRequests[0]])
  ];

  if (eids.length > 0) {
    standard.user = {
      ext: { eids }
    };

    native.user = {
      ext: { eids }
    };
  }

  let ext = _getExt(schain, globalFpd);

  if (!isEmpty(ext)) {
    standard.ext = ext;
    native.ext = ext;
  }
  return {
    standard: standard,
    native: native
  };
}

function _getMediaType(bid) {
  if (_isInstreamBidRequest(bid)) return 'video';
  if (_isNativeBidRequest(bid)) return 'native';
  return 'banner';
}

function _isNativeBidRequest(bidRequest) {
  return !!(bidRequest.mediaTypes.native && bidRequest.nativeParams);
}

function _isInstreamBidRequest(bidRequest) {
  if (!bidRequest.mediaTypes.video) return false;
  if (!bidRequest.mediaTypes.video.context) return false;
  if (bidRequest.mediaTypes.video.context.toLowerCase() === 'instream') {
    return true;
  } else {
    return false;
  }
}

function _getORTBVideo(bidRequest) {
  // give precedent to mediaTypes.video
  let video = { ...bidRequest.params.video, ...bidRequest.mediaTypes.video };
  if (!video.w) video.w = video.playerSize[0][0];
  if (!video.h) video.h = video.playerSize[0][1];
  if (video.context === 'instream') video.placement = 1;
  // clean up oRTB object
  delete video.playerSize;
  return video;
}

function _getFloor(bid) {
  let floor = null;
  if (typeof bid.getFloor === 'function') {
    const floorInfo = bid.getFloor({
      currency: 'USD',
      mediaType: _getMediaType(bid),
      size: '*'
    });
    if (
      typeof floorInfo === 'object' &&
      floorInfo.currency === 'USD' &&
      !isNaN(parseFloat(floorInfo.floor))
    ) {
      floor = parseFloat(floorInfo.floor);
    }
  }
  return floor !== null ? floor : bid.params.floor;
}

function _getGlobalFpd(bidderRequest) {
  const fpd = {};
  const context = {};
  const user = {};
  const ortbData = bidderRequest.ortb2 || {};
  const opeCloudStorage = _fetchOpeCloud();

  const fpdContext = Object.assign({}, ortbData.site);
  const fpdUser = Object.assign({}, ortbData.user);

  if (opeCloudStorage) {
    fpdUser.data = fpdUser.data || []
    try {
      fpdUser.data.push({
        name: 'www.1plusx.com',
        ext: opeCloudStorage
      })
    } catch (err) {
      logError('Triplelift: error adding 1plusX segments: ', err);
    }
  }

  _addEntries(context, fpdContext);
  _addEntries(user, fpdUser);

  if (!isEmpty(context)) {
    fpd.context = context;
  }
  if (!isEmpty(user)) {
    fpd.user = user;
  }
  return fpd;
}

function _fetchOpeCloud() {
  const opeCloud = storage.getDataFromLocalStorage('opecloud_ctx');
  if (!opeCloud) return null;
  try {
    const parsedJson = JSON.parse(opeCloud);
    return parsedJson
  } catch (err) {
    logError('Triplelift: error parsing JSON: ', err);
    return null
  }
}

function _getAdUnitFpd(adUnitFpd) {
  const fpd = {};
  const context = {};

  _addEntries(context, adUnitFpd.ext);

  if (!isEmpty(context)) {
    fpd.context = context;
  }

  return fpd;
}

function _addEntries(target, source) {
  if (!isEmpty(source)) {
    Object.keys(source).forEach(key => {
      if (source[key] != null) {
        target[key] = source[key];
      }
    });
  }
}

function _getExt(schain, fpd) {
  let ext = {};
  if (!isEmpty(schain)) {
    ext.schain = { ...schain };
  }
  if (!isEmpty(fpd)) {
    ext.fpd = { ...fpd };
  }
  return ext;
}

function getUnifiedIdEids(bidRequest) {
  return getEids(bidRequest, 'tdid', 'adserver.org', 'TDID');
}

function getIdentityLinkEids(bidRequest) {
  return getEids(bidRequest, 'idl_env', 'liveramp.com', 'idl');
}

function getCriteoEids(bidRequest) {
  return getEids(bidRequest, 'criteoId', 'criteo.com', 'criteoId');
}

function getPubCommonEids(bidRequest) {
  return getEids(bidRequest, 'pubcid', 'pubcid.org', 'pubcid');
}

function getEids(bidRequest, type, source, rtiPartner) {
  return bidRequest
    .map(getUserId(type)) // bids -> userIds of a certain type
    .filter(filterEids(type)) // filter out unqualified userIds
    .map(formatEid(source, rtiPartner)); // userIds -> eid objects
}

const filterEids = type => (userId, i, arr) => {
  let isValidUserId =
    !!userId && // is not null nor empty
    (isStr(userId)
      ? !!userId
      : isPlainObject(userId) && // or, is object
        !isArray(userId) && // not an array
        !isEmpty(userId) && // is not empty
        userId.id && // contains nested id field
        isStr(userId.id) && // nested id field is a string
        !!userId.id); // that is not empty
  if (!isValidUserId && arr[0] !== undefined) {
    logWarn(`Triplelift: invalid ${type} userId format`);
  }
  return isValidUserId;
};

function getUserId(type) {
  return bid => bid && bid.userId && bid.userId[type];
}

function formatEid(source, rtiPartner) {
  return userId => ({
    source,
    uids: [
      {
        id: userId.id ? userId.id : userId,
        ext: { rtiPartner }
      }
    ]
  });
}

function _sizes(sizeArray) {
  let sizes = sizeArray.filter(_isValidSize);
  return sizes.map(function (size) {
    return {
      w: size[0],
      h: size[1]
    };
  });
}

function _isValidSize(size) {
  return size.length === 2 && typeof size[0] === 'number' && typeof size[1] === 'number';
}

function _buildResponseObject(bid, standardUnits, nativeUnits) {
  let bidResponse = {};
  let width = bid.width || 1;
  let height = bid.height || 1;
  let dealId = bid.deal_id || '';
  let creativeId = bid.crid || '';

  if (bid.native_ad) {
    let breqNative = nativeUnits[bid.imp_id]

    let body = bid.native_ad.body || '';
    let icon = bid.native_ad.icon || '';
    let image = bid.native_ad.image || '';
    let cta = bid.native_ad.cta || '';
    let adChoices = bid.native_ad.adChoices || '';

    if (bid.native_ad.image?.sizes) {
      bid.native_ad.image.sizes = _sizes(bid.native_ad.image.sizes);
    }
    if (bid.cpm != 0) {
      bidResponse = {
        requestId: breqNative.bidId,
        cpm: bid.cpm,
        width: width,
        height: height,
        native: {
          image: image,
          title: bid.native_ad.title,
          clickUrl: bid.native_ad.clickUrl,
          sponsoredBy: bid.native_ad.sponsoredBy,
          impressionTrackers: bid.native_ad.impTrackers,
          clickTrackers: bid.native_ad.clickTrackers,
          body: body,
          icon: icon,
          cta: cta,
          adChoices: adChoices
        },
        netRevenue: true,
        dealId: dealId,
        creativeId: creativeId,
        currency: 'USD',
        ttl: BANNER_TIME_TO_LIVE,
        mediaType: 'native',
        meta: {
          mediaType: 'native'
        }
      };
    }
    return bidResponse;
  }

  let breqStandard = standardUnits[bid.imp_id];

  if (bid.cpm != 0 && bid.ad) {
    bidResponse = {
      requestId: breqStandard.bidId,
      cpm: bid.cpm,
      width: width,
      height: height,
      netRevenue: true,
      ad: bid.ad,
      creativeId: creativeId,
      dealId: dealId,
      currency: 'USD',
      ttl: BANNER_TIME_TO_LIVE,
      tl_source: bid.tl_source,
      meta: {}
    };

    if (_isInstreamBidRequest(breqStandard)) {
      bidResponse.vastXml = bid.ad;
      bidResponse.mediaType = 'video';
      bidResponse.ttl = INSTREAM_TIME_TO_LIVE;
    }

    if (bid.advertiser_name) {
      bidResponse.meta.advertiserName = bid.advertiser_name;
    }

    if (bid.adomain && bid.adomain.length) {
      bidResponse.meta.advertiserDomains = bid.adomain;
    }

    if (bid.tl_source && bid.tl_source == 'hdx') {
      bidResponse.meta.mediaType = 'banner';
    }

    if (bid.tl_source && bid.tl_source == 'tlx') {
      bidResponse.meta.mediaType = 'native';
    }
  }
  return bidResponse;
}

function _filterData(obj) {
  let result = {};

  for (const key in obj) {
    if (!isEmpty(obj[key].imp)) {
      result[key] = obj[key];
    }
  }

  return result;
}

registerBidder(tripleliftAdapterSpec);