#!/usr/bin/env node
/*
 * Sealed build: run the QUnit browser test suite (test/index.html) in
 * headless Chrome and print per-module results plus a summary.
 *
 * Usage: node .github/scripts/qunit-headless.js <url>
 *
 * Requires Node >= 18 and puppeteer-core. puppeteer-core is NOT one of the
 * project's (node 0.10) devDependencies: install it in a separate directory
 * and point NODE_PATH (or PUPPETEER_CORE_PATH) at it.
 *
 * Output is kept compact so a truncated CI log still shows the result:
 * one "MODULE ..." line per module (in completion order), a "FAIL ..." line
 * with its assertion messages for every failing test, a heartbeat at most
 * every 30s, and a final "QUnit summary: ..." line. The full per-test
 * PASS/FAIL list is written to QUNIT_RESULTS_FILE.
 *
 * Env:
 *   CHROME_BIN          Chrome executable (default: google-chrome-stable)
 *   PUPPETEER_CORE_PATH explicit path to the puppeteer-core module (optional)
 *   QUNIT_TIMEOUT_MS    overall timeout (default: 15 minutes)
 *   QUNIT_RESULTS_FILE  full per-test results (default: /tmp/qunit-results.txt)
 *
 * Exit code: 0 only if QUnit finished and no test failed.
 */
"use strict";

var fs = require( "fs" );
var url = process.argv[ 2 ];
var timeoutMs = parseInt( process.env.QUNIT_TIMEOUT_MS || "", 10 ) || 15 * 60 * 1000;
var chromeBin = process.env.CHROME_BIN || "google-chrome-stable";
var resultsFile = process.env.QUNIT_RESULTS_FILE || "/tmp/qunit-results.txt";
var HEARTBEAT_MS = 30 * 1000;

// Flush stdout before exiting so the last lines are never lost.
function exitWith( code ) {
	process.exitCode = code;
	process.stdout.write( "", function() {
		process.exit( code );
	} );
}

if ( !url ) {
	console.error( "Usage: node .github/scripts/qunit-headless.js <url>" );
	exitWith( 2 );
	return;
}

var puppeteer = require( process.env.PUPPETEER_CORE_PATH || "puppeteer-core" );

// Runs in the page before any script: hook QUnit as soon as it is assigned
// to window so no test result is missed. Top frame only (iframes in the suite
// reuse parent.QUnit).
function installHooks() {
	if ( window !== window.top ) {
		return;
	}
	var current = null;
	var hooked = false;
	function hook( Q ) {
		if ( hooked || !Q || typeof Q.testDone !== "function" ) {
			return;
		}
		hooked = true;
		Q.testStart( function() {
			current = { failures: [] };
		} );
		Q.log( function( d ) {
			if ( !d.result && current ) {
				var msg = d.message || "(no message)";
				if ( d.hasOwnProperty( "expected" ) ) {
					msg += " | expected: " + Q.jsDump.parse( d.expected ) +
						" | actual: " + Q.jsDump.parse( d.actual );
				}
				current.failures.push( msg );
			}
		} );
		Q.testDone( function( d ) {
			window.__qhReport( JSON.stringify( {
				type: "test",
				module: d.module,
				name: d.name,
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				failures: current ? current.failures : []
			} ) );
			current = null;
		} );
		Q.done( function( d ) {
			window.__qhReport( JSON.stringify( {
				type: "done",
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} ) );
		} );
	}
	var value;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return value;
		},
		set: function( v ) {
			value = v;
			hook( v );
		}
	} );
}

function main() {
	var tests = { total: 0, passed: 0, failed: 0 };
	// Stats of the module currently running; printed when the module changes.
	var mod = null;
	var browser;
	var finish;
	var finished = new Promise( function( resolve ) {
		finish = resolve;
	} );

	fs.writeFileSync( resultsFile, "" );

	function flushModule() {
		if ( mod ) {
			console.log( "MODULE " + mod.name + ": " + mod.total + " tests, " + mod.passed +
				" passed, " + mod.failed + " failed (" + mod.assertPassed + "/" +
				mod.assertTotal + " assertions)" );
			mod = null;
		}
	}

	function onReport( json ) {
		var d = JSON.parse( json );
		if ( d.type === "test" ) {
			var line = ( d.failed > 0 ? "FAIL " : "PASS " ) + d.module + " :: " + d.name +
				" (" + d.passed + "/" + d.total + " assertions)";
			var details = d.failures.map( function( f ) {
				return "    - " + f;
			} );
			fs.appendFileSync( resultsFile, [ line ].concat( details ).join( "\n" ) + "\n" );

			if ( mod && mod.name !== d.module ) {
				flushModule();
			}
			if ( !mod ) {
				mod = { name: d.module, total: 0, passed: 0, failed: 0, assertPassed: 0, assertTotal: 0 };
			}
			mod.total++;
			mod.assertPassed += d.passed;
			mod.assertTotal += d.total;
			tests.total++;
			if ( d.failed > 0 ) {
				mod.failed++;
				tests.failed++;
				console.log( [ line ].concat( details ).join( "\n" ) );
			} else {
				mod.passed++;
				tests.passed++;
			}
		} else if ( d.type === "done" ) {
			finish( d );
		}
	}

	var heartbeat = setInterval( function() {
		console.log( "... " + tests.total + " tests done (" + tests.failed + " failed)" +
			( mod ? ", running module " + mod.name : "" ) );
	}, HEARTBEAT_MS );

	var timer = setTimeout( function() {
		finish( null );
	}, timeoutMs );

	return puppeteer.launch( {
		executablePath: chromeBin,
		headless: "new",
		args: [ "--headless=new", "--no-sandbox", "--disable-dev-shm-usage" ],
		protocolTimeout: timeoutMs
	} ).then( function( b ) {
		browser = b;
		return browser.newPage();
	} ).then( function( page ) {
		page.on( "dialog", function( dialog ) {
			dialog.dismiss().catch( function() {} );
		} );
		page.on( "pageerror", function( err ) {
			console.log( "[page error] " + ( err && err.message ? err.message : err ) );
		} );
		page.on( "error", function( err ) {
			console.log( "[page crashed] " + err );
			finish( null );
		} );
		return page.exposeFunction( "__qhReport", onReport ).then( function() {
			return page.evaluateOnNewDocument( installHooks );
		} ).then( function() {
			return page.goto( url, { waitUntil: "load", timeout: 120000 } );
		} ).then( function() {
			return finished;
		} );
	} ).then( function( done ) {
		clearTimeout( timer );
		clearInterval( heartbeat );
		flushModule();
		console.log( "Full per-test results: " + resultsFile );
		var ok;
		if ( !done ) {
			console.log( "QUnit summary: TIMEOUT or crash after " + tests.total + " tests (" +
				tests.passed + " passed, " + tests.failed + " failed)" );
			ok = false;
		} else {
			console.log( "QUnit summary: " + tests.total + " tests, " + tests.passed +
				" passed, " + tests.failed + " failed; " + done.passed + " assertions of " +
				done.total + " passed (" + done.failed + " failed) in " + done.runtime + " ms" );
			ok = tests.total > 0 && tests.failed === 0 && done.failed === 0;
		}
		return browser.close().catch( function() {} ).then( function() {
			exitWith( ok ? 0 : 1 );
		} );
	} ).catch( function( err ) {
		clearTimeout( timer );
		clearInterval( heartbeat );
		flushModule();
		console.log( "qunit-headless: " + ( err && err.stack ? err.stack : err ) );
		console.log( "QUnit summary: runner error after " + tests.total + " tests (" +
			tests.passed + " passed, " + tests.failed + " failed)" );
		var p = browser ? browser.close().catch( function() {} ) : Promise.resolve();
		return p.then( function() {
			exitWith( 1 );
		} );
	} );
}

main();
