import _ from 'lodash';
import semver from 'semver';

import { errorUtils, pkgUtils, validatioUtils } from '@verdaccio/core';
import { API_ERROR, DIST_TAGS, HTTP_STATUS, USERS } from '@verdaccio/core';
import { Package, StringValue, Version } from '@verdaccio/types';
import { generateRandomHexString, isNil, normalizeDistTags } from '@verdaccio/utils';

import { LocalStorage } from './local-storage';
import { SearchInstance } from './search';

export const STORAGE = {
  PACKAGE_FILE_NAME: 'package.json',
  FILE_EXIST_ERROR: 'EEXISTS',
  NO_SUCH_FILE_ERROR: 'ENOENT',
  DEFAULT_REVISION: '0-0000000000000000',
};

export function generatePackageTemplate(name: string): Package {
  return {
    // standard things
    name,
    versions: {},
    time: {},
    [USERS]: {},
    [DIST_TAGS]: {},
    _uplinks: {},
    _distfiles: {},
    _attachments: {},
    _rev: '',
  };
}

/**
 * Normalize package properties, tags, revision id.
 * @param {Object} pkg package reference.
 */
export function normalizePackage(pkg: Package): Package {
  const pkgProperties = ['versions', 'dist-tags', '_distfiles', '_attachments', '_uplinks', 'time'];

  pkgProperties.forEach((key): void => {
    const pkgProp = pkg[key];

    if (isNil(pkgProp) || validatioUtils.isObject(pkgProp) === false) {
      pkg[key] = {};
    }
  });

  if (_.isString(pkg._rev) === false) {
    pkg._rev = STORAGE.DEFAULT_REVISION;
  }

  if (_.isString(pkg._id) === false) {
    pkg._id = pkg.name;
  }

  // normalize dist-tags
  return normalizeDistTags(pkg);
}

export function generateRevision(rev: string): string {
  const _rev = rev.split('-');

  return (+_rev[0] || 0) + 1 + '-' + generateRandomHexString();
}

export function getLatestReadme(pkg: Package): string {
  const versions = pkg['versions'] || {};
  const distTags = pkg[DIST_TAGS] || {};
  // FIXME: here is a bit tricky add the types
  const latestVersion: Version | any = distTags['latest'] ? versions[distTags['latest']] || {} : {};
  let readme = _.trim(pkg.readme || latestVersion.readme || '');
  if (readme) {
    return readme;
  }

  // In case of empty readme - trying to get ANY readme in the following order:
  // 'next','beta','alpha','test','dev','canary'
  const readmeDistTagsPriority = ['next', 'beta', 'alpha', 'test', 'dev', 'canary'];
  readmeDistTagsPriority.forEach(function (tag): string | void {
    if (readme) {
      return readme;
    }
    const version: Version | any = distTags[tag] ? versions[distTags[tag]] || {} : {};
    readme = _.trim(version.readme || readme);
  });
  return readme;
}

// FIXME: type any due this
export function cleanUpReadme(version: any): Version {
  if (isNil(version) === false) {
    delete version.readme;
  }

  return version;
}

export const WHITELIST = [
  '_rev',
  'name',
  'versions',
  'dist-tags',
  'readme',
  'time',
  '_id',
  'users',
];

export function cleanUpLinksRef(result: Package, keepUpLinkData?: boolean): Package {
  const propertyToKeep = [...WHITELIST];
  if (keepUpLinkData === true) {
    propertyToKeep.push('_uplinks');
  }

  for (const i in result) {
    if (propertyToKeep.indexOf(i) === -1) {
      // Remove sections like '_uplinks' from response
      delete result[i];
    }
  }

  return result;
}

/**
 * Check whether a package it is already a local package
 * @param {*} name
 * @param {*} localStorage
 */
export function checkPackageLocal(name: string, localStorage: LocalStorage): Promise<any> {
  return new Promise<void>((resolve, reject): void => {
    localStorage.getPackageMetadata(name, (err, results): void => {
      if (!isNil(err) && err.status !== HTTP_STATUS.NOT_FOUND) {
        return reject(err);
      }
      if (results) {
        return reject(errorUtils.getConflict(API_ERROR.PACKAGE_EXIST));
      }
      return resolve();
    });
  });
}

export function publishPackage(
  name: string,
  metadata: any,
  localStorage: LocalStorage
): Promise<any> {
  return new Promise<void>((resolve, reject): void => {
    localStorage.addPackage(name, metadata, (err, latest): void => {
      if (!_.isNull(err)) {
        return reject(err);
      } else if (!_.isUndefined(latest)) {
        SearchInstance.add(latest);
      }
      return resolve();
    });
  });
}

export function checkPackageRemote(
  name: string,
  isAllowPublishOffline: boolean,
  syncMetadata: Function
): Promise<any> {
  return new Promise<void>((resolve, reject): void => {
    syncMetadata(name, null, {}, (err, packageJsonLocal, upLinksErrors): void => {
      // something weird
      if (err && err.status !== HTTP_STATUS.NOT_FOUND) {
        return reject(err);
      }

      // checking package exist already
      if (isNil(packageJsonLocal) === false) {
        return reject(errorUtils.getConflict(API_ERROR.PACKAGE_EXIST));
      }

      for (let errorItem = 0; errorItem < upLinksErrors.length; errorItem++) {
        // checking error
        // if uplink fails with a status other than 404, we report failure
        if (isNil(upLinksErrors[errorItem][0]) === false) {
          if (upLinksErrors[errorItem][0].status !== HTTP_STATUS.NOT_FOUND) {
            if (isAllowPublishOffline) {
              return resolve();
            }

            return reject(errorUtils.getServiceUnavailable(API_ERROR.UPLINK_OFFLINE_PUBLISH));
          }
        }
      }

      return resolve();
    });
  });
}

export function mergeUplinkTimeIntoLocal(localMetadata: Package, remoteMetadata: Package): any {
  if ('time' in remoteMetadata) {
    return Object.assign({}, localMetadata.time, remoteMetadata.time);
  }

  return localMetadata.time;
}

export function prepareSearchPackage(data: Package): any {
  const latest = pkgUtils.getLatest(data);

  if (latest && data.versions[latest]) {
    const version: Version = data.versions[latest];
    const versions: any = { [latest]: 'latest' };
    const pkg: any = {
      name: version.name,
      description: version.description,
      [DIST_TAGS]: { latest },
      maintainers: version.maintainers || [version.author].filter(Boolean),
      author: version.author,
      repository: version.repository,
      readmeFilename: version.readmeFilename || '',
      homepage: version.homepage,
      keywords: version.keywords,
      bugs: version.bugs,
      license: version.license,
      // time: {
      //   modified: time,
      // },
      versions,
    };

    return pkg;
  }
}

/**
 * Create a tag for a package
 * @param {*} data
 * @param {*} version
 * @param {*} tag
 * @return {Boolean} whether a package has been tagged
 */
export function tagVersion(data: Package, version: string, tag: StringValue): boolean {
  if (tag && data[DIST_TAGS][tag] !== version && semver.parse(version, true)) {
    // valid version - store
    data[DIST_TAGS][tag] = version;
    return true;
  }
  return false;
}
