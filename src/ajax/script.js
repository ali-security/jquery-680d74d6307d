define([
	"../core",
	"../ajax"
], function( jQuery ) {

var originAnchor = document.createElement( "a" );

// #8138, IE may throw an exception when accessing
// a field from window.location if document.domain has been set
try {
	originAnchor.href = location.href;
} catch( e ) {
	originAnchor.href = "";
}

// Support: IE8-11+
// Anchor's host property isn't correctly set when the href is relative
originAnchor.href = originAnchor.href;

// Prevent auto-execution of scripts when no explicit dataType was provided (See gh-2432)
jQuery.ajaxPrefilter(function( s, origOptions ) {
	var urlAnchor,
		crossDomain = s.crossDomain;

	// The protocol:host:port crossDomain detection can miss urls the browser
	// resolves to another origin (e.g. "\\example.com/"); unless crossDomain was
	// set explicitly, double-check the origin with the browser's own url parser
	if ( !crossDomain && origOptions.crossDomain == null &&
		jQuery.ajaxSettings.crossDomain == null ) {

		urlAnchor = document.createElement( "a" );

		// Support: IE8-11+
		// IE throws exception if url is malformed, e.g. http://example.com:80x/
		try {
			urlAnchor.href = s.url;

			// Support: IE8-11+
			// Anchor's host property isn't correctly set when s.url is relative
			urlAnchor.href = urlAnchor.href;
			crossDomain = originAnchor.protocol + "//" + originAnchor.host !==
				urlAnchor.protocol + "//" + urlAnchor.host;
		} catch( e ) {

			// If there is an error parsing the URL, assume it is crossDomain
			crossDomain = true;
		}
	}

	if ( crossDomain ) {
		s.contents.script = false;
	}
});

// Install script dataType
jQuery.ajaxSetup({
	accepts: {
		script: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"
	},
	contents: {
		script: /(?:java|ecma)script/
	},
	converters: {
		"text script": function( text ) {
			jQuery.globalEval( text );
			return text;
		}
	}
});

// Handle cache's special case and global
jQuery.ajaxPrefilter( "script", function( s ) {
	if ( s.cache === undefined ) {
		s.cache = false;
	}
	if ( s.crossDomain ) {
		s.type = "GET";
		s.global = false;
	}
});

// Bind script tag hack transport
jQuery.ajaxTransport( "script", function(s) {

	// This transport only deals with cross domain requests
	if ( s.crossDomain ) {

		var script,
			head = document.head || jQuery("head")[0] || document.documentElement;

		return {

			send: function( _, callback ) {

				script = document.createElement("script");

				script.async = true;

				if ( s.scriptCharset ) {
					script.charset = s.scriptCharset;
				}

				script.src = s.url;

				// Attach handlers for all browsers
				script.onload = script.onreadystatechange = function( _, isAbort ) {

					if ( isAbort || !script.readyState || /loaded|complete/.test( script.readyState ) ) {

						// Handle memory leak in IE
						script.onload = script.onreadystatechange = null;

						// Remove the script
						if ( script.parentNode ) {
							script.parentNode.removeChild( script );
						}

						// Dereference the script
						script = null;

						// Callback if not abort
						if ( !isAbort ) {
							callback( 200, "success" );
						}
					}
				};

				// Circumvent IE6 bugs with base elements (#2709 and #4378) by prepending
				// Use native DOM manipulation to avoid our domManip AJAX trickery
				head.insertBefore( script, head.firstChild );
			},

			abort: function() {
				if ( script ) {
					script.onload( undefined, true );
				}
			}
		};
	}
});

});
